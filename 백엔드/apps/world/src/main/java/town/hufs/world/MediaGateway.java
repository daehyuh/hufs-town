package town.hufs.world;

import com.fasterxml.jackson.databind.*;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Value;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import town.hufs.domain.MediaPolicy;
import town.hufs.protocol.MediaOffer;
import java.io.IOException;
import java.net.*;
import java.net.http.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.*;

/** Bounded control-plane I/O. No HTTP requests run on the world actor. */
@Component
public class MediaGateway {
    private static final Logger log=LoggerFactory.getLogger(MediaGateway.class);
    // The SFU starts this relative lease when it receives the latest coalesced snapshot.
    private static final long POLICY_LEASE_MILLIS=2_000;
    public record Applied(String id,long epoch,String engineId,List<String> peers,List<MediaOffer> offers) {}
    public record Reply(boolean ok,String dataJson,String code,String message) {}
    public record RecordingParticipant(String playerId,String userId,String name,long epoch) {}
    private record Grant(String id,long epoch,String domain,List<String> peers,List<String> sources) {}
    private record Frame(String worldId,long sequence,long leaseMillis,List<Grant> people) {}
    private record Snapshot(long sequence,List<Grant> people) {}
    private record Work(Snapshot snapshot,Consumer<List<Applied>> callback) {}
    private final boolean enabled;private final String endpoint,token,worldId=UUID.randomUUID().toString();
    private final ObjectMapper json=new ObjectMapper();
    private final HttpClient http=HttpClient.newBuilder().connectTimeout(Duration.ofMillis(500)).build();
    private final ScheduledExecutorService policies=Executors.newSingleThreadScheduledExecutor();
    // One sequential RPC queue runs per participant; keep enough workers for a full 12-person voice group.
    private final ThreadPoolExecutor requests=new ThreadPoolExecutor(16,16,0,TimeUnit.SECONDS,new ArrayBlockingQueue<>(512));
    private final AtomicReference<Work> latest=new AtomicReference<>();private final AtomicLong sequence=new AtomicLong();
    private final AtomicReference<String> policyFailure=new AtomicReference<>();
    public MediaGateway(@Value("${TOWN_MEDIA_ENABLED:false}")boolean enabled,@Value("${MEDIA_CONTROL_URL:http://127.0.0.1:18082}")String endpoint,@Value("${MEDIA_CONTROL_TOKEN:}")String token){
        this.enabled=enabled;this.endpoint=endpoint;this.token=token;
        if(enabled&&token.length()<32)throw new IllegalStateException("Run scripts/media.ps1 start to configure MEDIA_CONTROL_TOKEN");
        if(enabled)policies.scheduleWithFixedDelay(this::flush,0,150,TimeUnit.MILLISECONDS);
    }
    public boolean enabled(){return enabled;}
    public void publish(List<MediaPolicy.Person> people,MediaPolicy.Decision decision,Consumer<List<Applied>> callback){
        if(!enabled)return;
        var grants=people.stream().filter(MediaPolicy.Person::enabled).map(p->new Grant(p.id(),p.policyEpoch(),p.domain(),List.copyOf(decision.peers().getOrDefault(p.id(),Set.of())),Arrays.stream(MediaPolicy.Source.values()).filter(source->MediaPolicy.sourceAllowed(p,source)).map(Enum::name).toList())).toList();
        latest.set(new Work(new Snapshot(sequence.incrementAndGet(),grants),callback));
    }
    private void flush(){
        var work=latest.getAndSet(null);if(work==null)return;
        deliverPolicy(work,false);
    }
    private void deliverPolicy(Work work,boolean retried){
        try{
            var snapshot=work.snapshot;
            var frame=new Frame(worldId,snapshot.sequence(),POLICY_LEASE_MILLIS,snapshot.people());
            var result=post("policy",frame);var applied=new ArrayList<Applied>();for(var p:result.path("people"))applied.add(new Applied(p.path("id").asText(),p.path("epoch").asLong(),result.path("instanceId").asText(),json.convertValue(p.path("peers"),new com.fasterxml.jackson.core.type.TypeReference<List<String>>(){}),json.convertValue(p.path("offers"),new com.fasterxml.jackson.core.type.TypeReference<List<MediaOffer>>(){})));
            String previous=policyFailure.getAndSet(null);if(previous!=null)log.info("Media policy delivery recovered after {}",previous);
            work.callback.accept(applied);
        }
        catch(Exception unavailable){
            String reason=safeFailureLabel(unavailable);
            if(unavailable instanceof IOException&&!retried){
                // A transport failure may happen after the SFU applied the frame.
                // Retry a fresh, newest snapshot before briefly taking every client offline.
                var retry=latest.getAndSet(null);
                if(retry==null)retry=new Work(new Snapshot(sequence.incrementAndGet(),work.snapshot.people()),work.callback);
                deliverPolicy(retry,true);
                return;
            }
            String previous=policyFailure.getAndSet(reason);if(!reason.equals(previous))
                log.warn("Media policy delivery failed ({})",reason);
            work.callback.accept(null);
        }
    }
    public void revoke(String playerId,long epoch,Runnable applied){
        if(!enabled){applied.run();return;}
        execute(()->{try{post("revoke",Map.of("worldId",worldId,"playerId",playerId,"epoch",epoch));applied.run();}catch(Exception unavailable){/* World barrier waits for the old bounded lease to expire. */}},()->{});
    }
    public void request(String playerId,long epoch,String method,String dataJson,Consumer<Reply> done){
        if(!enabled){done.accept(new Reply(false,"{}","MEDIA_DISABLED","통화 서버가 아직 켜지지 않았어요."));return;}
        execute(()->{
            try{JsonNode data=json.readTree(dataJson);if(data==null||!data.isObject())throw new IllegalArgumentException();var result=post("rpc",Map.of("worldId",worldId,"playerId",playerId,"epoch",epoch,"method",method,"data",data),Duration.ofMillis(4500));done.accept(new Reply(true,json.writeValueAsString(result),"",""));}
            catch(ControlFailure failure){done.accept(new Reply(false,"{}",failure.code,failure.getMessage()));}
            catch(Exception unavailable){log.warn("Media RPC failed ({})",safeFailureType(unavailable));done.accept(new Reply(false,"{}","MEDIA_UNAVAILABLE","통화 서버에 연결할 수 없어요. 다시 연결을 눌러 주세요."));}
        },()->done.accept(new Reply(false,"{}","MEDIA_BUSY","통화 서버가 바빠요. 잠시 후 다시 연결해 주세요.")));
    }
    static String safeFailureType(Throwable failure){return failure==null?"Unknown":failure.getClass().getSimpleName();}
    static String safeFailureLabel(Throwable failure){
        if(failure instanceof ControlFailure rejected)
            return safeControlFailureLabel(rejected.status,rejected.code)+":"+safeControlFailureReason(rejected.getMessage());
        return safeFailureType(failure);
    }
    static String safeControlFailureLabel(int status,String code){
        String safeCode=code!=null&&code.matches("[A-Z0-9_]{1,64}")?code:"UNKNOWN";
        int safeStatus=status>=400&&status<=599?status:0;
        return "ControlFailure:"+safeStatus+":"+safeCode;
    }
    static String safeControlFailureReason(String message){
        if(message==null)return "UNKNOWN";
        return switch(message){
            case "통화 정책 프레임이 올바르지 않아요." -> "POLICY_FRAME";
            case "통화 정책의 유효 시간이 지났어요." -> "POLICY_LEASE";
            case "통화 참가자 목록이 올바르지 않아요." -> "PARTICIPANT_LIST";
            case "통화 참가자 ID·구역·접속 번호가 올바르지 않아요." -> "PARTICIPANT_ID_DOMAIN_EPOCH";
            case "통화 허용 대상 목록이 올바르지 않아요." -> "PEER_LIST";
            case "미디어 송출 허용 목록이 올바르지 않아요." -> "SOURCE_LIST";
            case "미디어 서버가 바빠요." -> "CAPACITY";
            default -> "OTHER";
        };
    }
    /** Internal world-coordinator path; never exposed through the client media RPC. */
    public void startRecording(String recordingId,String domain,String spaceId,String mapId,String mapRevision,
                               String zoneId,String requestedByUserId,List<String> sources,boolean transcribe,
                               List<RecordingParticipant> participants,Consumer<Reply> done){
        Map<String,Object> body=Map.ofEntries(Map.entry("worldId",worldId),Map.entry("recordingId",recordingId),
            Map.entry("domain",domain),Map.entry("spaceId",spaceId),Map.entry("mapId",mapId),
            Map.entry("mapRevision",mapRevision),Map.entry("zoneId",zoneId),Map.entry("requestedByUserId",requestedByUserId),
            Map.entry("sources",List.copyOf(sources)),Map.entry("transcribe",transcribe),
            Map.entry("participants",participants.stream().map(p->Map.of("playerId",p.playerId(),"userId",p.userId(),"name",p.name(),"epoch",p.epoch())).toList()));
        recording("recording/start",body,done);
    }
    /** Internal world-coordinator path; never exposed through the client media RPC. */
    public void stopRecording(String recordingId,Consumer<Reply> done){
        recording("recording/stop",Map.of("worldId",worldId,"recordingId",recordingId),done);
    }
    private void recording(String route,Map<String,Object> body,Consumer<Reply> done){
        if(!enabled){done.accept(new Reply(false,"{}","MEDIA_DISABLED","녹화 서버를 사용할 수 없어요."));return;}
        execute(()->{
            try{var result=post(route,body,Duration.ofSeconds(15));done.accept(new Reply(true,json.writeValueAsString(result),"",""));}
            catch(ControlFailure failure){done.accept(new Reply(false,"{}",failure.code,failure.getMessage()));}
            catch(Exception unavailable){done.accept(new Reply(false,"{}","MEDIA_UNAVAILABLE","녹화를 시작하거나 종료하지 못했어요."));}
        },()->done.accept(new Reply(false,"{}","MEDIA_BUSY","녹화 서버가 바빠요. 잠시 후 다시 시도해 주세요.")));
    }
    private void execute(Runnable action,Runnable rejected){try{requests.execute(action);}catch(RejectedExecutionException busy){rejected.run();}}
    private JsonNode post(String route,Object body)throws Exception{
        return post(route,body,Duration.ofMillis(1100));
    }
    private JsonNode post(String route,Object body,Duration timeout)throws Exception{
        var request=HttpRequest.newBuilder(URI.create(endpoint+"/v1/"+route)).timeout(timeout).header("Authorization","Bearer "+token).header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body))).build();
        var response=http.send(request,HttpResponse.BodyHandlers.ofString());var value=json.readTree(response.body());
        if(response.statusCode()!=200)throw new ControlFailure(response.statusCode(),value.path("code").asText("MEDIA_UNAVAILABLE"),value.path("message").asText("통화 서버에 연결할 수 없어요."));
        return value;
    }
    private static final class ControlFailure extends Exception{final int status;final String code;ControlFailure(int status,String code,String message){super(message);this.status=status;this.code=code;}}
    @PreDestroy public void close(){policies.shutdownNow();requests.shutdownNow();http.close();}
}
