package town.hufs.domain;

import town.hufs.protocol.*;
import java.util.*;
import java.util.function.Function;

public final class MapRules {
    private MapRules() {}
    public static final class Invalid extends RuntimeException {
        public Invalid(String message) { super(message); }
    }
    private static void require(boolean valid, String message) { if (!valid) throw new Invalid(message); }
    private static boolean finite(double n) { return Double.isFinite(n); }
    private record Rotation(double cos, double sin) {}
    private static Rotation directionRotation(String direction) {
        return switch (direction) {
            case "left" -> new Rotation(0, -1);
            case "up" -> new Rotation(-1, 0);
            case "right" -> new Rotation(0, 1);
            default -> new Rotation(1, 0);
        };
    }
    private static Rect rotatedRect(Rect rect, double centerX, double centerY, String direction) {
        var rotation = directionRotation(direction);
        double dx = rect.x() + rect.width() / 2 - centerX;
        double dy = rect.y() + rect.height() / 2 - centerY;
        double cos = rotation.cos(), sin = rotation.sin();
        double x = centerX + dx * cos - dy * sin;
        double y = centerY + dx * sin + dy * cos;
        double width = Math.abs(cos) * rect.width() + Math.abs(sin) * rect.height();
        double height = Math.abs(sin) * rect.width() + Math.abs(cos) * rect.height();
        return new Rect(x - width / 2, y - height / 2, width, height);
    }
    private static void text(String value, int max, String name) { require(value != null && !value.isBlank() && value.length() <= max && value.codePoints().noneMatch(c -> Character.isISOControl(c) || Character.getType(c) == Character.FORMAT), name + " 형식을 확인해 주세요."); }
    private static void bounds(Rect r, MapDefinition map) {
        require(r != null && finite(r.x()) && finite(r.y()) && finite(r.width()) && finite(r.height()) && r.x() >= 0 && r.y() >= 0 && r.width() >= .125 && r.height() >= .125 && r.x()+r.width() <= map.width() && r.y()+r.height() <= map.height(), "맵 밖으로 나가거나 크기가 잘못된 영역이 있어요.");
    }
    private static void id(Set<String> ids, String id) { require(id != null && id.matches("[A-Za-z0-9_-]{1,80}") && ids.add(id), "맵 요소 ID가 없거나 중복되었어요."); }
    public static boolean customAssetId(String id) {
        return id != null && id.matches("custom_[0-9a-fA-F-]{36}");
    }
    private static OfficeCatalog.Asset asset(String id, Function<String, OfficeCatalog.Asset> customAssets) {
        var asset = OfficeCatalog.asset(id);
        return asset != null ? asset : customAssetId(id) ? customAssets.apply(id) : null;
    }
    public static MapDefinition normalize(MapDefinition m, String mapId, String revision) {
        return normalize(m, mapId, revision, id -> null);
    }
    public static MapDefinition normalize(MapDefinition m, String mapId, String revision,
                                         Function<String, OfficeCatalog.Asset> customAssets) {
        require(m != null && m.schemaVersion() == 2, "지원하지 않는 맵 형식이에요.");
        require(m.width() >= 16 && m.width() <= 96 && m.height() >= 16 && m.height() <= 96, "맵 크기는 가로·세로 16~96칸이에요.");
        text(m.name(), 60, "맵 이름");
        require(finite(m.spawnX()) && finite(m.spawnY()) && m.spawnX() > .25 && m.spawnY() > .25 && m.spawnX() < m.width()-.25 && m.spawnY() < m.height()-.25, "시작 위치를 맵 안에 지정해 주세요.");
        var portals = m.portals() == null ? List.<Portal>of() : m.portals();
        require(m.floors() != null && !m.floors().isEmpty() && m.floors().size() <= 256 && m.walls() != null && m.walls().size() <= 256 && m.objects() != null && m.objects().size() <= 500 && m.labels() != null && m.labels().size() <= 100 && m.zones() != null && m.zones().size() <= 32 && portals.size() <= 64, "바닥 1~256개, 벽 256개, 가구 500개, 문구 100개, 구역 32개, 포털 64개까지 배치할 수 있어요.");
        var ids = new HashSet<String>(); var collisions = new ArrayList<Rect>();
        var objects = new ArrayList<MapObject>();
        for (var f : m.floors()) { require(f != null, "빈 바닥이 있어요."); id(ids, f.id()); bounds(f.bounds(), m); require(Set.of("OAK","WOOD","CARPET_BLUE","CARPET_SAGE","TILE","CONCRETE","GRASS","PAVERS").contains(Objects.toString(f.material(), "")), "알 수 없는 바닥 재질이에요."); }
        for (var w : m.walls()) { require(w != null, "빈 벽이 있어요."); id(ids, w.id()); bounds(w.bounds(), m); require(Set.of("CREAM","SAGE","GLASS").contains(Objects.toString(w.material(), "")), "알 수 없는 벽 재질이에요."); collisions.add(w.bounds()); }
        for (var o : m.objects()) {
            require(o != null, "빈 오브젝트가 있어요."); id(ids, o.id()); var asset = asset(o.asset(), customAssets);
            require(asset != null && finite(o.x()) && finite(o.y()) && (o.scale()==1 || o.scale()==2 || o.scale()==3), "알 수 없는 가구나 잘못된 크기가 있어요.");
            String direction = Objects.toString(o.direction(), "down");
            require(Set.of("down", "left", "up", "right").contains(direction), "가구 방향을 확인해 주세요.");
            double s = o.scale()/2, width=asset.width()*o.scale()/32, height=asset.height()*o.scale()/32;
            double centerY = o.y() - height / 2;
            Rect spriteBounds = rotatedRect(new Rect(o.x()-width/2, o.y()-height, width, height), o.x(), centerY, direction);
            bounds(spriteBounds, m);
            var interaction = o.interaction();
            if (interaction != null) {
                var kind = Objects.toString(interaction.kind(), "");
                require(Set.of("NOTICE", "LINK", "VIDEO", "IMAGE", "BOARD", "NPC", "SOUND", "SCAVENGER_ITEM").contains(kind), "가구 상호작용 종류를 확인해 주세요.");
                text(interaction.title(), 80, "상호작용 제목");
                var body = interaction.body();
                require(body == null || (body.length() <= 2000 && body.codePoints().noneMatch(c -> (Character.isISOControl(c) && c != '\n' && c != '\t') || Character.getType(c) == Character.FORMAT)), "상호작용 내용이 너무 길거나 올바르지 않아요.");
                if ("NPC".equals(kind))
                    require(body != null && !body.isBlank() && body.lines().count() <= 50, "NPC 대사는 1~50줄로 입력해 주세요.");
                if ("SCAVENGER_ITEM".equals(kind))
                    require(body == null || body.codePointCount(0, body.length()) <= 280, "수집 퀘스트 단서는 280자까지 입력할 수 있어요.");
                var url = Objects.toString(interaction.url(), "").strip();
                if ("LINK".equals(interaction.kind()) || "VIDEO".equals(interaction.kind()))
                    require(url.matches("https?://[^\\s]+") && url.length() <= 2048, "외부 링크는 HTTP 또는 HTTPS 주소만 사용할 수 있어요.");
                else if ("SOUND".equals(kind)) {
                    require(url.matches("(?i)^https://[^\\s?#]+\\.(mp3|ogg|wav|m4a|aac|flac|webm)(?:\\?[^\\s#]*)?(?:#[^\\s]*)?$") && url.length() <= 2048,
                        "환경음은 HTTPS로 제공되는 MP3, OGG, WAV, M4A, AAC, FLAC, WEBM 파일만 사용할 수 있어요.");
                    require(interaction.radius() >= 1 && interaction.radius() <= 20,
                        "환경음 반경은 1~20칸으로 설정해 주세요.");
                    require(interaction.volume() >= 1 && interaction.volume() <= 100,
                        "환경음 볼륨은 1~100으로 설정해 주세요.");
                    require(body == null || body.isBlank(), "환경음 상호작용에는 대사나 설명을 넣을 수 없어요.");
                }
                else require(url.isEmpty(), "공지·이미지·게시판·NPC 상호작용에는 외부 링크를 넣을 수 없어요.");
                if (!"SOUND".equals(kind))
                    require(interaction.radius() == 0 && interaction.volume() == 0, "환경음 설정은 환경음 상호작용에만 사용할 수 있어요.");
                var interactionAssetId = interaction.assetId();
                if ("IMAGE".equals(kind)) {
                    require(customAssetId(interactionAssetId) && customAssets.apply(interactionAssetId) != null, "이미지 상호작용은 현재 공간에 업로드된 이미지를 선택해야 해요.");
                } else require(interactionAssetId == null || interactionAssetId.isBlank(), "업로드 이미지 참조는 이미지 상호작용에만 사용할 수 있어요.");
            }
            Rect f = asset.footprint(); if (f != null) {
                Rect footprint = new Rect(o.x()+(f.x()-asset.width()/32)*s, o.y()+f.y()*s, f.width()*s, f.height()*s);
                collisions.add(rotatedRect(footprint, o.x(), centerY, direction));
            }
            objects.add(new MapObject(o.id(), o.asset(), o.x(), o.y(), o.scale(), direction, interaction));
        }
        for (var label : m.labels()) {
            require(label != null, "빈 문구가 있어요.");
            id(ids,label.id());
            text(label.text(),40,"문구");
            require(finite(label.x()) && finite(label.y()) && label.x() >= 0 && label.y() >= 0 && label.x() <= m.width() && label.y() <= m.height(), "문구 위치를 확인해 주세요.");
            var link = Objects.toString(label.link(), "").strip();
            require(link.isEmpty() || link.matches("https?://[^\\s]+"), "안내 링크는 HTTP 또는 HTTPS 주소만 사용할 수 있어요.");
        }
        var zones = new ArrayList<Zone>();
        for (var zone : m.zones()) {
            require(zone != null, "빈 구역이 있어요."); id(ids,zone.id()); text(zone.name(),40,"구역 이름"); bounds(zone.bounds(),m);
            require(Set.of("PUBLIC","PRIVATE","SILENT","STAGE").contains(Objects.toString(zone.kind(),"")), "구역 종류를 확인해 주세요.");
            Long capacity = zone.capacity();
            if ("PRIVATE".equals(zone.kind())) {
                capacity = capacity == null ? 12 : capacity;
                require(capacity >= 2 && capacity <= 100, "회의실 정원은 2~100명으로 설정해 주세요.");
            } else require(capacity == null, "정원 설정은 독립 회의 구역에만 사용할 수 있어요.");
            if ("STAGE".equals(zone.kind()))
                require(zone.bounds().width() >= 3 && zone.bounds().height() >= 2, "발표 무대는 가로 3칸, 세로 2칸 이상으로 지정해 주세요.");
            zones.add(new Zone(zone.id(), zone.name(), zone.kind(), zone.bounds(), capacity));
        }
        for (var portal : portals) {
            require(portal != null, "빈 포털이 있어요.");
            id(ids, portal.id());
            text(portal.name(), 40, "포털 이름");
            bounds(portal.bounds(), m);
            require(portal.targetSpaceId() != null && portal.targetSpaceId().matches("[A-Za-z0-9_-]{1,80}"), "포털 대상 공간을 확인해 주세요.");
            require(portal.targetMapId() == null || portal.targetMapId().isBlank()
                || portal.targetMapId().matches("[A-Za-z0-9_-]{1,80}"), "포털 대상 지도를 확인해 주세요.");
            require(finite(portal.targetSpawnX()) && finite(portal.targetSpawnY()) && portal.targetSpawnX() >= 0 && portal.targetSpawnY() >= 0 && portal.targetSpawnX() <= 96 && portal.targetSpawnY() <= 96, "포털 도착 위치를 확인해 주세요.");
        }
        for (int a=0;a<m.zones().size();a++) for(int b=a+1;b<m.zones().size();b++) {
            var x=m.zones().get(a).bounds(); var y=m.zones().get(b).bounds();
            require(!(x.x()<y.x()+y.width() && x.x()+x.width()>y.x() && x.y()<y.y()+y.height() && x.y()+x.height()>y.y()), "서로 겹친 대화 구역이 있어요.");
        }
        return new MapDefinition(2,mapId,revision,m.name().strip(),m.width(),m.height(),m.spawnX(),m.spawnY(),List.copyOf(collisions),List.copyOf(objects),List.copyOf(zones),List.copyOf(m.floors()),List.copyOf(m.walls()),List.copyOf(m.labels()),List.copyOf(portals));
    }
    public static List<String> issues(MapDefinition map) {
        var issues=new ArrayList<String>();
        if (!Movement.canStand(map,map.spawnX(),map.spawnY())) { issues.add("시작 위치가 벽이나 가구 안에 있어요."); return issues; }
        int width=(int)map.width()*2,height=(int)map.height()*2; var seen=new boolean[width*height];var queue=new ArrayDeque<Integer>();
        int sx=(int)(map.spawnX()*2),sy=(int)(map.spawnY()*2);
        // A valid spawn can round into a blocked grid cell. Seed only cells actually reachable from it.
        for(int x=Math.max(0,sx-1);x<=Math.min(width-1,sx+1);x++)for(int y=Math.max(0,sy-1);y<=Math.min(height-1,sy+1);y++){
            double px=(x+.5)/2,py=(y+.5)/2;boolean reachable=true;
            for(int step=1;step<=8;step++)if(!Movement.canStand(map,map.spawnX()+(px-map.spawnX())*step/8,map.spawnY()+(py-map.spawnY())*step/8)){reachable=false;break;}
            if(reachable){queue.add(y*width+x);seen[y*width+x]=true;}
        }
        int count=0;var reached=new HashSet<String>();
        while(!queue.isEmpty()) { int cell=queue.removeFirst(),x=cell%width,y=cell/width;count++;
            double px=(x+.5)/2,py=(y+.5)/2;
            for(var z:map.zones())if(Movement.inside(z.bounds(),px,py))reached.add(z.id());
            for(int[] delta:new int[][]{{1,0},{-1,0},{0,1},{0,-1}}) {int nx=x+delta[0],ny=y+delta[1];if(nx<0||ny<0||nx>=width||ny>=height)continue;int next=ny*width+nx;
                if(!seen[next] && Movement.canStand(map,(nx+.5)/2,(ny+.5)/2) && Movement.canStand(map,(x+nx+1)/4.0,(y+ny+1)/4.0)) {seen[next]=true;queue.add(next);}
            }
        }
        if(count<16)issues.add("시작 위치 주변에 이동할 공간이 부족해요.");
        for(var z:map.zones())if(!reached.contains(z.id()))issues.add(z.name()+" 구역으로 이동할 수 없어요. 출입구를 열어 주세요.");
        return issues;
    }
}
