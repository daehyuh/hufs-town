package town.hufs.auth;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import town.hufs.protocol.MapDefinition;
import java.util.List;

public final class PublishedMaps {
    public record Published(long sequence, MapDefinition map) {}
    private final StringRedisTemplate redis;
    private final ObjectMapper json = new ObjectMapper();
    private static final DefaultRedisScript<Long> PUT = new DefaultRedisScript<>("""
        local old = redis.call('GET',KEYS[1])
        if old then
          local sep = string.find(old,string.char(10),1,true)
          if sep and tonumber(string.sub(old,1,sep-1)) >= tonumber(ARGV[1]) then return 0 end
        end
        redis.call('SET',KEYS[1],ARGV[1]..string.char(10)..ARGV[2])
        return 1
        """, Long.class);
    public PublishedMaps(StringRedisTemplate redis) { this.redis=redis; }
    public void publish(String space, long sequence, String document) { publish(space,space,sequence,document); }
    public void publish(String space, String mapId, long sequence, String document) {
        redis.execute(PUT,List.of(key(space,mapId)),Long.toString(sequence),document);
    }
    public Published read(String space) { return read(space,space); }
    public Published read(String space, String mapId) {
        String value=redis.opsForValue().get(key(space,mapId)); if(value==null)return null;
        int separator=value.indexOf('\n');
        if(separator>=0&&"DELETED".equals(value.substring(separator+1)))return null;
        try { return new Published(Long.parseLong(value.substring(0,separator)),json.readValue(value.substring(separator+1),MapDefinition.class)); }
        catch(Exception e) { throw new IllegalStateException("Published map cache invalid",e); }
    }
    public void remove(String space,String mapId) { redis.opsForValue().set(key(space,mapId),"9223372036854775807\nDELETED"); }
    private static String key(String space,String mapId) {
        return "hufs-town:published-map:"+space+(space.equals(mapId)?"":":"+mapId);
    }
}
