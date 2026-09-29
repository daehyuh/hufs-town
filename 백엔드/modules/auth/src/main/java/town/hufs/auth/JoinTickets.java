package town.hufs.auth;

import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.*;
import java.util.concurrent.TimeUnit;

/** Short-lived admission tickets backed by globally shared, renewable space seats. */
public final class JoinTickets {
    private static final long TICKET_TTL_MILLIS = 30_000;
    private static final long SEAT_LEASE_MILLIS = 20_000;
    private static final long OWNER_LEASE_MILLIS = 10_000;
    private final StringRedisTemplate redis;
    private final SecureRandom random = new SecureRandom();

    private static final DefaultRedisScript<Long> RESERVE = new DefaultRedisScript<>("""
        local now = tonumber(ARGV[1])
        local seats = KEYS[1]
        redis.call('ZREMRANGEBYSCORE', seats, '-inf', now)
        local seatId = ''
        local resumeToken = ARGV[9]
        local reused = '0'
        if ARGV[8] == '1' then
            local alias = redis.call('GET', KEYS[3])
            if alias then
                local separator = string.find(alias, '\\n', 1, true)
                if separator and string.sub(alias, separator + 1) == ARGV[6] then
                    local candidate = string.sub(alias, 1, separator - 1)
                    local score = redis.call('ZSCORE', seats, candidate)
                    if score and tonumber(score) > now then seatId = candidate end
                end
            end
        else
            local alias = redis.call('GET', KEYS[4])
            if alias then
                local first = string.find(alias, '\\n', 1, true)
                local second = first and string.find(alias, '\\n', first + 1, true)
                local third = second and string.find(alias, '\\n', second + 1, true)
                if first and second and third and string.sub(alias, first + 1, third - 1) == ARGV[6]
                    and string.sub(alias, third + 1) ~= '' then
                    local candidate = string.sub(alias, 1, first - 1)
                    local score = redis.call('ZSCORE', seats, candidate)
                    if score and tonumber(score) > now then
                        seatId = candidate
                        resumeToken = string.sub(alias, third + 1)
                    end
                end
            end
        end
        if seatId ~= '' then
            reused = '1'
            redis.call('ZADD', seats, now + tonumber(ARGV[5]), seatId)
        else
            if tonumber(redis.call('ZCARD', seats)) >= tonumber(ARGV[2]) then return 0 end
            seatId = ARGV[4]
            redis.call('ZADD', seats, now + tonumber(ARGV[5]), seatId)
        end
        local lease = math.ceil(tonumber(ARGV[5]) / 1000)
        redis.call('SET', KEYS[3], seatId .. '\\n' .. ARGV[6], 'EX', lease)
        redis.call('SET', KEYS[4], seatId .. '\\n' .. ARGV[6] .. '\\n' .. resumeToken, 'EX', lease)
        redis.call('SET', KEYS[2], ARGV[7] .. seatId .. '\\n' .. reused .. '\\n' .. resumeToken,
            'EX', math.ceil(tonumber(ARGV[10]) / 1000))
        return 1
        """, Long.class);

    private static final DefaultRedisScript<String> CONSUME = new DefaultRedisScript<>("""
        local v = redis.call('GET', KEYS[1])
        if not v or string.sub(v, 1, string.len(ARGV[1])) ~= ARGV[1] then return nil end
        local seatId, reused, resumeToken = string.match(v, '\\n([^\\n]+)\\n([01])\\n([^\\n]+)$')
        if not seatId or not resumeToken then return nil end
        local _, _, spaceId = string.match(v, '^([^\\n]*)\\n([^\\n]*)\\n([^\\n]*)\\n')
        if not spaceId then return nil end
        local score = redis.call('ZSCORE', 'hufs-town:seats:' .. spaceId, seatId)
        if not score or tonumber(score) <= tonumber(ARGV[2]) then
            redis.call('DEL', KEYS[1])
            return nil
        end
        redis.call('DEL', KEYS[1])
        return string.sub(v, string.len(ARGV[1]) + 1)
        """, String.class);

    private static final DefaultRedisScript<Long> RELEASE_SEAT = new DefaultRedisScript<>("""
        local owner = redis.call('GET', KEYS[3])
        local expected = ''
        if ARGV[2] ~= '' then expected = ARGV[2] .. '|' .. ARGV[3] end
        if owner and owner ~= expected then return 0 end
        if not owner and expected ~= '' then return 0 end
        redis.call('ZREM', KEYS[1], ARGV[1])
        if owner then redis.call('DEL', KEYS[3]) end
        local alias = redis.call('GET', KEYS[2])
        if alias then
            local separator = string.find(alias, '\\n', 1, true)
            if separator and string.sub(alias, 1, separator - 1) == ARGV[1] then redis.call('DEL', KEYS[2]) end
        end
        local sessionAlias = redis.call('GET', KEYS[4])
        if sessionAlias then
            local separator = string.find(sessionAlias, '\\n', 1, true)
            if separator and string.sub(sessionAlias, 1, separator - 1) == ARGV[1] then redis.call('DEL', KEYS[4]) end
        end
        return 1
        """, Long.class);

    private static final DefaultRedisScript<String> CLAIM_OWNER = new DefaultRedisScript<>("""
        local now = tonumber(ARGV[1])
        local score = redis.call('ZSCORE', KEYS[1], ARGV[6])
        if not score or tonumber(score) <= now then return nil end
        local seatTtl = math.ceil(tonumber(ARGV[2]) / 1000)
        local ownerTtl = math.ceil(tonumber(ARGV[3]) / 1000)
        local owner = redis.call('GET', KEYS[2])
        if owner then
            local separator = string.find(owner, '|', 1, true)
            if not separator then return nil end
            if ARGV[8] ~= '1' then
                if string.sub(owner, 1, separator - 1) ~= ARGV[4] then return nil end
                local fence = string.sub(owner, separator + 1)
                redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[6])
                redis.call('SET', KEYS[4], ARGV[5], 'EX', seatTtl)
                redis.call('SET', KEYS[5], ARGV[7], 'EX', seatTtl)
                redis.call('EXPIRE', KEYS[2], ownerTtl)
                return fence .. '\\n0'
            end
        end
        local fence = redis.call('INCR', KEYS[3])
        local claim = ARGV[4] .. '|' .. fence
        redis.call('SET', KEYS[2], claim, 'EX', ownerTtl)
        redis.call('EXPIRE', KEYS[3], 2592000)
        redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[6])
        redis.call('SET', KEYS[4], ARGV[5], 'EX', seatTtl)
        redis.call('SET', KEYS[5], ARGV[7], 'EX', seatTtl)
        return tostring(fence) .. '\\n1'
        """, String.class);

    private static final DefaultRedisScript<String> RENEW_SEATS = new DefaultRedisScript<>("""
        local now = tonumber(ARGV[1])
        local expires = now + tonumber(ARGV[2])
        local ownerTtl = math.ceil(tonumber(ARGV[3]) / 1000)
        local count = (#KEYS - 1) / 3
        local failed = {}
        for i = 1, count do
            local member = ARGV[5 + (i - 1) * 4]
            local fence = ARGV[6 + (i - 1) * 4]
            local score = redis.call('ZSCORE', KEYS[1], member)
            local owner = redis.call('GET', KEYS[3 + (i - 1) * 3])
            if score and tonumber(score) > now and owner == ARGV[4] .. '|' .. fence then
                local aliasValue = ARGV[7 + (i - 1) * 4]
                redis.call('ZADD', KEYS[1], expires, member)
                redis.call('SET', KEYS[2 + (i - 1) * 3], aliasValue, 'EX', math.ceil(tonumber(ARGV[2]) / 1000))
                redis.call('SET', KEYS[4 + (i - 1) * 3], ARGV[8 + (i - 1) * 4], 'EX', math.ceil(tonumber(ARGV[2]) / 1000))
                redis.call('EXPIRE', KEYS[3 + (i - 1) * 3], ownerTtl)
            else
                table.insert(failed, member)
            end
        end
        return table.concat(failed, ',')
        """, String.class);

    public JoinTickets(StringRedisTemplate redis) { this.redis = redis; }

    public String issue(String userId, String sessionId, String spaceId, int capacity) {
        return issue(userId, sessionId, spaceId, spaceId, capacity, -1, -1, "");
    }
    public String issue(String userId, String sessionId, String spaceId, String mapId, int capacity) {
        return issue(userId, sessionId, spaceId, mapId, capacity, -1, -1, "");
    }
    public String issue(String userId, String sessionId, String spaceId, String mapId, int capacity, double spawnX, double spawnY) {
        return issue(userId, sessionId, spaceId, mapId, capacity, spawnX, spawnY, "");
    }
    public String issue(String userId, String sessionId, String spaceId, String mapId, int capacity,
                        double spawnX, double spawnY, String resumeToken) {
        if (capacity < 1 || blank(userId) || blank(sessionId) || blank(spaceId) || blank(mapId)) throw new IllegalArgumentException();
        byte[] bytes = new byte[32]; random.nextBytes(bytes);
        String token = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        String candidateSeatId = UUID.randomUUID().toString();
        boolean hasResumeToken = resumeToken != null && !resumeToken.isBlank();
        String aliasKey = hasResumeToken ? resumeAliasKey(spaceId, resumeToken) : "hufs-town:resume:none:" + token;
        String binding = userId + "\n" + sessionId;
        String candidateResumeToken = hasResumeToken ? resumeToken : newResumeToken();
        String valuePrefix = userId + "\n" + sessionId + "\n" + spaceId + "\n" + mapId + "\n" + capacity
            + "\n" + spawnX + "\n" + spawnY + "\n";
        Long reserved = redis.execute(RESERVE,
            List.of("hufs-town:seats:" + spaceId, "hufs-town:admission:" + token, aliasKey,
                sessionAliasKey(spaceId, userId, sessionId)),
            String.valueOf(System.currentTimeMillis()), String.valueOf(capacity), token, candidateSeatId,
            String.valueOf(SEAT_LEASE_MILLIS), binding, valuePrefix, hasResumeToken ? "1" : "0", candidateResumeToken,
            String.valueOf(TICKET_TTL_MILLIS));
        if (reserved == null) throw new Unavailable();
        if (reserved != 1L) throw new Full();
        return token;
    }

    public Admission consume(String token, String userId, String sessionId) {
        if (token == null || !token.matches("[A-Za-z0-9_-]{43}")) return null;
        String prefix = userId + "\n" + sessionId + "\n";
        String value = redis.execute(CONSUME, List.of("hufs-town:admission:" + token),
            prefix, String.valueOf(System.currentTimeMillis()));
        return parseAdmission(token, userId, sessionId, value);
    }

    private static Admission parseAdmission(String token, String userId, String sessionId, String value) {
        if (value == null) return null;
        String[] fields = value.split("\\n", -1);
        if (fields.length != 8) return null;
        try {
            return new Admission(token, userId, sessionId, fields[0], fields[1], Integer.parseInt(fields[2]),
                Double.parseDouble(fields[3]), Double.parseDouble(fields[4]), fields[5], "1".equals(fields[6]), fields[7]);
        } catch (RuntimeException invalid) { return null; }
    }

    public void release(Admission admission) {
        if (admission == null || admission.seatId() == null || admission.seatId().isBlank() || admission.reusedSeat()) return;
        releaseSeat(admission.spaceId(), admission.seatId(), admission.resumeToken(), admission.userId(), admission.sessionId(), "", 0);
    }

    public Ownership claimSeat(String spaceId, String seatId, String resumeToken, String userId, String sessionId, String nodeId) {
        return claimSeat(spaceId, seatId, resumeToken, userId, sessionId, nodeId, false);
    }

    public Ownership claimSeat(String spaceId, String seatId, String resumeToken, String userId, String sessionId,
                               String nodeId, boolean forceTakeover) {
        if (blank(spaceId) || blank(seatId) || blank(resumeToken) || blank(userId) || blank(sessionId) || blank(nodeId))
            throw new IllegalArgumentException("Invalid seat ownership claim");
        long requestStarted = System.nanoTime();
        String value = redis.execute(CLAIM_OWNER,
            List.of(seatSetKey(spaceId), ownerKey(spaceId, seatId), fenceKey(spaceId, seatId),
                resumeAliasKey(spaceId, resumeToken), sessionAliasKey(spaceId, userId, sessionId)),
            String.valueOf(System.currentTimeMillis()), String.valueOf(SEAT_LEASE_MILLIS), String.valueOf(OWNER_LEASE_MILLIS),
            nodeId, seatId + "\n" + userId + "\n" + sessionId, seatId,
            seatId + "\n" + userId + "\n" + sessionId + "\n" + resumeToken, forceTakeover ? "1" : "0");
        if (value == null) return null;
        String[] fields = value.split("\\n", -1);
        if (fields.length != 2) throw new Unavailable();
        try { return new Ownership(spaceId, seatId, resumeToken, userId, sessionId, nodeId, Long.parseLong(fields[0]), "1".equals(fields[1]),
            requestStarted + TimeUnit.MILLISECONDS.toNanos(OWNER_LEASE_MILLIS)); }
        catch (RuntimeException invalid) { throw new Unavailable(); }
    }

    public void releaseSeat(String spaceId, String seatId, String resumeToken) {
        releaseSeat(spaceId, seatId, resumeToken, "", 0);
    }
    public void releaseSeat(String spaceId, String seatId, String resumeToken, String nodeId, long fence) {
        releaseSeat(spaceId, seatId, resumeToken, "", "", nodeId, fence);
    }
    public void releaseSeat(String spaceId, String seatId, String resumeToken, String userId, String sessionId,
                            String nodeId, long fence) {
        if (blank(spaceId) || blank(seatId)) return;
        String aliasKey = blank(resumeToken) ? "hufs-town:resume:none:release" : resumeAliasKey(spaceId, resumeToken);
        String identityKey = blank(userId) || blank(sessionId) ? "hufs-town:resume:session:none" : sessionAliasKey(spaceId, userId, sessionId);
        redis.execute(RELEASE_SEAT, List.of(seatSetKey(spaceId), aliasKey, ownerKey(spaceId, seatId), identityKey),
            seatId, blank(nodeId) ? "" : nodeId, String.valueOf(fence));
    }
    public void releaseOwnership(Ownership owner) {
        if (owner == null) return;
        if (owner.newlyClaimed())
            releaseSeat(owner.spaceId(), owner.seatId(), owner.resumeToken(), owner.userId(), owner.sessionId(), owner.nodeId(), owner.fence());
    }

    /** Renews every seat for one space atomically. A missing lease fails closed. */
    public SeatRenewal renewSeats(String spaceId, Collection<SeatLease> leases) {
        if (leases == null || leases.isEmpty())
            return new SeatRenewal(System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(OWNER_LEASE_MILLIS), Set.of());
        List<SeatLease> requested = List.copyOf(leases);
        List<String> keys = new ArrayList<>(requested.size() * 3 + 1);
        keys.add(seatSetKey(spaceId));
        List<String> args = new ArrayList<>(requested.size() * 4 + 4);
        long now = System.currentTimeMillis();
        long requestStarted = System.nanoTime();
        args.add(String.valueOf(now));
        args.add(String.valueOf(SEAT_LEASE_MILLIS));
        args.add(String.valueOf(OWNER_LEASE_MILLIS));
        String nodeId = requested.getFirst().nodeId();
        if (blank(nodeId)) throw new IllegalArgumentException("Missing world node id");
        args.add(nodeId);
        for (SeatLease lease : requested) {
            if (!spaceId.equals(lease.spaceId()) || blank(lease.seatId()) || blank(lease.resumeToken()))
                throw new IllegalArgumentException("Invalid seat lease");
            if (!nodeId.equals(lease.nodeId()) || lease.fence() < 1)
                throw new IllegalArgumentException("Invalid seat owner fence");
            keys.add(resumeAliasKey(spaceId, lease.resumeToken()));
            keys.add(ownerKey(spaceId, lease.seatId()));
            keys.add(sessionAliasKey(spaceId, lease.userId(), lease.sessionId()));
            args.add(lease.seatId());
            args.add(String.valueOf(lease.fence()));
            args.add(lease.seatId() + "\n" + lease.userId() + "\n" + lease.sessionId());
            args.add(lease.seatId() + "\n" + lease.userId() + "\n" + lease.sessionId() + "\n" + lease.resumeToken());
        }
        String rejected = redis.execute(RENEW_SEATS, keys, args.toArray());
        if (rejected == null) throw new Unavailable();
        Set<String> rejectedIds = rejected.isBlank() ? Set.of() : Set.of(rejected.split(","));
        return new SeatRenewal(requestStarted + TimeUnit.MILLISECONDS.toNanos(OWNER_LEASE_MILLIS), rejectedIds);
    }

    private static String resumeAliasKey(String spaceId, String resumeToken) {
        return "hufs-town:resume:" + spaceId + ":" + sha256(resumeToken);
    }
    private static String sessionAliasKey(String spaceId, String userId, String sessionId) {
        return "hufs-town:resume-session:" + spaceId + ":" + sha256(userId + "\n" + sessionId);
    }
    private static String seatSetKey(String spaceId) { return "hufs-town:seats:" + spaceId; }
    private static String ownerKey(String spaceId, String seatId) { return "hufs-town:seat-owner:" + spaceId + ":" + seatId; }
    private static String fenceKey(String spaceId, String seatId) { return "hufs-town:seat-fence:" + spaceId + ":" + seatId; }
    private static String sha256(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
    private static boolean blank(String value) { return value == null || value.isBlank(); }
    private String newResumeToken() {
        return UUID.randomUUID() + "-" + UUID.randomUUID();
    }

    public record Admission(String token, String userId, String sessionId, String spaceId, String mapId, int capacity,
                            double spawnX, double spawnY, String seatId, boolean reusedSeat, String resumeToken) {}
    public record Ownership(String spaceId, String seatId, String resumeToken, String userId, String sessionId,
                            String nodeId, long fence,
                            boolean newlyClaimed, long leaseDeadlineNanos) {}
    public record SeatRenewal(long leaseDeadlineNanos, Set<String> rejectedSeatIds) {}
    public record SeatLease(String spaceId, String seatId, String resumeToken, String userId, String sessionId,
                           String nodeId, long fence) {}
    public static final class Full extends RuntimeException {}
    public static final class Unavailable extends RuntimeException {}
}
