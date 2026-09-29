package town.hufs.domain;

import java.util.*;

/** Stateful pairwise media eligibility over server-authoritative participants. */
public final class MediaPolicy {
    public static final int MAX_NEIGHBORS = 12, MAX_EVENT_LISTENERS = 100;
    public static final double ENTER_DISTANCE = 5, EXIT_DISTANCE = 7;
    public static final long ENTER_STABLE_MS = 200;

    public enum Source { MICROPHONE, CAMERA, SCREEN, SCREEN_AUDIO }
    public enum Scope { NEARBY, PRIVATE_ROOM, SILENT, EVENT }

    /** Coordinates a receiver group without relying on client-provided room names. */
    public record Domain(
        String spaceId,
        String mapId,
        String mapRevision,
        String zoneId,
        Scope scope,
        String eventId
    ) {
        public Domain {
            Objects.requireNonNull(spaceId);
            Objects.requireNonNull(mapId);
            Objects.requireNonNull(mapRevision);
            Objects.requireNonNull(zoneId);
            Objects.requireNonNull(scope);
            eventId = Objects.requireNonNullElse(eventId, "");
            if (scope == Scope.EVENT && eventId.isBlank())
                throw new IllegalArgumentException("An event domain needs an active event ID");
        }

        public String key() {
            if (scope == Scope.EVENT)
                return mediaSafe(spaceId) + "/event/" + mediaSafe(eventId);
            String spaceMap = mediaSafe(spaceId) + ":" + mediaSafe(mapId);
            String group = switch (scope) {
                case PRIVATE_ROOM -> "private:" + mediaSafe(zoneId);
                case SILENT -> "silent:" + mediaSafe(zoneId);
                case NEARBY -> "common";
                case EVENT -> throw new IllegalStateException("Handled above");
            };
            return spaceMap + "/" + mediaSafe(mapRevision) + "/" + group;
        }

        private static String mediaSafe(String value) {
            // Keep SFU room IDs within its accepted alphabet while preserving IDs used by this app.
            return value.replace('|', ':');
        }
    }

    /** Immutable policy input; policyEpoch fences every asynchronous media operation. */
    public record Person(
        String id,
        Domain domainContext,
        String kind,
        double x,
        double y,
        long policyEpoch,
        boolean enabled,
        Set<String> blocked,
        boolean moderatorMuted,
        Set<Source> moderatedSources,
        boolean eventSpeaker
    ) {
        public Person {
            Objects.requireNonNull(id);
            Objects.requireNonNull(domainContext);
            Objects.requireNonNull(kind);
            blocked = blocked == null ? Set.of() : Set.copyOf(blocked);
            moderatedSources = moderatedSources == null ? Set.of() : Set.copyOf(moderatedSources);
        }

        public String domain() { return domainContext.key(); }
        public Scope scope() { return domainContext.scope(); }
        public boolean eventMode() { return scope() == Scope.EVENT; }
    }

    /** Symmetric allowed-peer result plus an explicit signal that capacity trimmed edges. */
    public record Decision(Map<String, Set<String>> peers, Set<String> limited) {}
    public record Edge(String a, String b) {
        public static Edge of(String a, String b) { return a.compareTo(b) < 0 ? new Edge(a, b) : new Edge(b, a); }
    }

    private Set<Edge> active = Set.of();
    private final Map<Edge, Long> entering = new HashMap<>();
    private final Map<String, String> identities = new HashMap<>();

    public Decision update(List<Person> people, long now) {
        var current = new HashMap<String, String>();
        var byId = new HashMap<String, Person>();
        for (var person : people) {
            current.put(person.id(), person.domain() + "/" + person.policyEpoch());
            byId.put(person.id(), person);
        }
        var changed = new HashSet<String>();
        current.forEach((id, identity) -> { if (!identity.equals(identities.get(id))) changed.add(id); });
        var candidates = new ArrayList<Candidate>();
        var observed = new HashSet<Edge>();
        var peers = new LinkedHashMap<String, Set<String>>();
        people.stream().sorted(Comparator.comparing(Person::id)).forEach(person -> peers.put(person.id(), new TreeSet<>()));

        var peopleByDomain = new HashMap<String, List<Person>>();
        for (var person : people) peopleByDomain.computeIfAbsent(person.domain(), ignored -> new ArrayList<>()).add(person);
        for (var domainPeople : peopleByDomain.values()) {
            var scopes = domainPeople.stream().map(Person::scope).distinct().toList();
            if (scopes.size() != 1) {
                // A malformed key collision must not make policy depend on the group representative.
                for (int i = 0; i < domainPeople.size(); i++) for (int j = i + 1; j < domainPeople.size(); j++)
                    consider(domainPeople.get(i), domainPeople.get(j), now, changed, candidates, observed);
                continue;
            }
            switch (scopes.getFirst()) {
                case NEARBY -> nearbyPairs(domainPeople, now, changed, candidates, observed);
                case PRIVATE_ROOM -> allPairs(domainPeople, now, changed, candidates, observed);
                case EVENT -> eventPairs(domainPeople, now, changed, candidates, observed);
                case SILENT -> { /* Silent participants never produce candidate edges. */ }
            }
        }
        entering.keySet().retainAll(observed);
        candidates.sort(Comparator.comparing(Candidate::retained).reversed()
            .thenComparingDouble(Candidate::distance).thenComparing(candidate -> candidate.edge().a())
            .thenComparing(candidate -> candidate.edge().b()));
        var next = new HashSet<Edge>();
        var limited = new HashSet<String>();
        for (var candidate : candidates) {
            var a = peers.get(candidate.edge().a());
            var b = peers.get(candidate.edge().b());
            var left = byId.get(candidate.edge().a());
            var right = byId.get(candidate.edge().b());
            int limit = left.eventMode() && right.eventMode() ? MAX_EVENT_LISTENERS : MAX_NEIGHBORS;
            if (a.size() >= limit || b.size() >= limit) {
                limited.add(candidate.edge().a());
                limited.add(candidate.edge().b());
                continue;
            }
            a.add(candidate.edge().b());
            b.add(candidate.edge().a());
            next.add(candidate.edge());
        }
        active = Set.copyOf(next);
        identities.clear();
        identities.putAll(current);
        var immutable = new LinkedHashMap<String, Set<String>>();
        peers.forEach((id, set) -> immutable.put(id, Collections.unmodifiableSet(set)));
        return new Decision(Collections.unmodifiableMap(immutable), Set.copyOf(limited));
    }

    private void nearbyPairs(List<Person> people, long now, Set<String> changed,
                             List<Candidate> candidates, Set<Edge> observed) {
        var buckets = new HashMap<Cell, List<Person>>();
        for (var person : people) {
            if (!person.enabled() || !Double.isFinite(person.x()) || !Double.isFinite(person.y())) continue;
            buckets.computeIfAbsent(cell(person), ignored -> new ArrayList<>()).add(person);
        }
        for (var a : people) {
            if (!a.enabled() || !Double.isFinite(a.x()) || !Double.isFinite(a.y())) continue;
            var origin = cell(a);
            for (int dx = -1; dx <= 1; dx++) for (int dy = -1; dy <= 1; dy++) {
                if ((dx < 0 && origin.x() == Long.MIN_VALUE) || (dx > 0 && origin.x() == Long.MAX_VALUE)
                    || (dy < 0 && origin.y() == Long.MIN_VALUE) || (dy > 0 && origin.y() == Long.MAX_VALUE)) continue;
                var neighbors = buckets.get(new Cell(origin.x() + dx, origin.y() + dy));
                if (neighbors == null) continue;
                for (var b : neighbors) if (a.id().compareTo(b.id()) < 0)
                    consider(a, b, now, changed, candidates, observed);
            }
        }
    }

    private void eventPairs(List<Person> people, long now, Set<String> changed,
                            List<Candidate> candidates, Set<Edge> observed) {
        var speakers = people.stream().filter(Person::eventSpeaker).toList();
        for (var speaker : speakers) for (var participant : people) {
            if (speaker.id().equals(participant.id())) continue;
            if (participant.eventSpeaker() && speaker.id().compareTo(participant.id()) > 0) continue;
            consider(speaker, participant, now, changed, candidates, observed);
        }
    }

    private void allPairs(List<Person> people, long now, Set<String> changed,
                          List<Candidate> candidates, Set<Edge> observed) {
        for (int i = 0; i < people.size(); i++) for (int j = i + 1; j < people.size(); j++)
            consider(people.get(i), people.get(j), now, changed, candidates, observed);
    }

    private void consider(Person a, Person b, long now, Set<String> changed,
                          List<Candidate> candidates, Set<Edge> observed) {
        var edge = Edge.of(a.id(), b.id());
        if (!eligible(a, b)) return;
        double distance = Math.hypot(a.x() - b.x(), a.y() - b.y());
        boolean privateRoom = a.scope() == Scope.PRIVATE_ROOM;
        boolean retained = active.contains(edge) && !changed.contains(a.id()) && !changed.contains(b.id());
        boolean event = a.eventMode() && b.eventMode();
        if (event) {
            if (!a.eventSpeaker() && !b.eventSpeaker()) return;
        } else if (!privateRoom && distance > (retained ? EXIT_DISTANCE : ENTER_DISTANCE)) return;
        observed.add(edge);
        if (changed.contains(a.id()) || changed.contains(b.id())) entering.remove(edge);
        long since = entering.computeIfAbsent(edge, ignored -> now);
        if (privateRoom || retained || now - since >= ENTER_STABLE_MS)
            candidates.add(new Candidate(edge, distance, retained));
    }

    private static Cell cell(Person person) {
        return new Cell(cellCoordinate(person.x()), cellCoordinate(person.y()));
    }

    private static long cellCoordinate(double coordinate) {
        double cell = Math.floor(coordinate / EXIT_DISTANCE);
        if (cell <= Long.MIN_VALUE) return Long.MIN_VALUE;
        if (cell >= Long.MAX_VALUE) return Long.MAX_VALUE;
        return (long) cell;
    }

    public static boolean eligible(Person a, Person b) {
        return !a.id().equals(b.id()) && a.enabled() && b.enabled()
            && Double.isFinite(a.x()) && Double.isFinite(a.y()) && Double.isFinite(b.x()) && Double.isFinite(b.y())
            && a.scope() != Scope.SILENT && b.scope() != Scope.SILENT
            && a.domain().equals(b.domain()) && !a.blocked().contains(b.id()) && !b.blocked().contains(a.id());
    }

    public static boolean sourceAllowed(Person sender, Source source) {
        return sender.enabled() && sender.scope() != Scope.SILENT
            && (!sender.eventMode() || sender.eventSpeaker()) && !sender.moderatedSources().contains(source)
            && (!sender.moderatorMuted() || (source != Source.MICROPHONE && source != Source.SCREEN_AUDIO));
    }

    private record Candidate(Edge edge, double distance, boolean retained) {}
    private record Cell(long x, long y) {}
}
