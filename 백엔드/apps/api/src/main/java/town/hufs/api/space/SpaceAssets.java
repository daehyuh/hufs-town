package town.hufs.api.space;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.multipart.MultipartFile;
import town.hufs.domain.MapRules;
import town.hufs.protocol.MapDefinition;
import town.hufs.protocol.OfficeCatalog;
import town.hufs.protocol.Rect;

import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import java.io.ByteArrayInputStream;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.nio.file.*;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.*;

@Service
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
public class SpaceAssets {
    private static final Logger log = LoggerFactory.getLogger(SpaceAssets.class);
    private static final long MAX_BYTES = 2L * 1024 * 1024;
    private static final long MAX_SPACE_BYTES = 100L * 1024 * 1024;
    private static final int MAX_DIMENSION = 2048;
    private static final int MAX_STORED_DIMENSION = 512;
    private static final int MAX_ASSETS_PER_SPACE = 500;
    private static final long ABANDONED_UPLOAD_AGE_MILLIS = Duration.ofHours(24).toMillis();
    private final Spaces spaces;
    private final JdbcTemplate db;
    private final TransactionTemplate tx;
    private final Path root;

    SpaceAssets(Spaces spaces, JdbcTemplate db, TransactionTemplate tx,
                @Value("${town.asset-root:.local/hufs-town/assets}") String configuredRoot) {
        this.spaces = spaces;
        this.db = db;
        this.tx = tx;
        this.root = Path.of(configuredRoot).toAbsolutePath().normalize();
        try { Files.createDirectories(this.root); }
        catch (IOException e) { throw new IllegalStateException("Asset storage is unavailable", e); }
    }

    record Asset(String id, String name, String url, String thumbnailUrl, int width, int height,
                 Rect footprint, String category, String source, String layer, String status) {}
    record PendingAsset(String id, String name, String uploadedBy, int width, int height,
                        long uploadedAt, String reviewContentUrl) {}

    List<Asset> list(String spaceId, String userId) {
        spaces.detail(spaceId, userId);
        return db.query("""
            SELECT id,original_name,thumbnail_key,width,height FROM space_asset
            WHERE space_id=? AND status='READY' ORDER BY created_at,id
            """, (r, n) -> view(r.getString("id"), r.getString("original_name"), r.getString("thumbnail_key"),
                r.getInt("width"), r.getInt("height"), spaceId, "READY"), spaceId);
    }

    Asset upload(String spaceId, String userId, MultipartFile file) {
        spaces.requireManager(spaceId, userId);
        if (file == null || file.isEmpty() || file.getSize() > MAX_BYTES)
            throw new SpaceFailure(413, "ASSET_TOO_LARGE", "에셋은 2MB 이하로 올려 주세요.");
        String mime = Optional.ofNullable(file.getContentType()).orElse("").toLowerCase(Locale.ROOT);
        if (!Set.of("image/png", "image/jpeg").contains(mime))
            throw new SpaceFailure(415, "ASSET_TYPE_UNSUPPORTED", "PNG 또는 JPEG 이미지만 올릴 수 있어요.");
        byte[] encoded;
        try { encoded = file.getBytes(); }
        catch (IOException e) { throw new SpaceFailure(400, "ASSET_INVALID", "업로드 파일을 읽을 수 없어요."); }
        BufferedImage image = decodeBoundedImage(encoded, mime);
        String hash = HexFormat.of().formatHex(sha256(encoded));
        BufferedImage storedImage = resize(image, MAX_STORED_DIMENSION);

        String id = "custom_" + UUID.randomUUID();
        String storageKey = UUID.randomUUID() + ".png";
        String thumbnailKey = UUID.randomUUID() + ".png";
        Path temporary = root.resolve(".upload-" + UUID.randomUUID());
        Path thumbnailTemporary = root.resolve(".upload-thumb-" + UUID.randomUUID());
        Path target = safePath(storageKey);
        Path thumbnailTarget = safePath(thumbnailKey);
        try {
            if (!ImageIO.write(storedImage, "PNG", temporary.toFile()))
                throw new IOException("PNG encoder unavailable");
            if (!ImageIO.write(thumbnail(storedImage, 96), "PNG", thumbnailTemporary.toFile()))
                throw new IOException("PNG thumbnail encoder unavailable");
            moveAtomically(temporary, target);
            moveAtomically(thumbnailTemporary, thumbnailTarget);
            String name = safeName(file.getOriginalFilename());
            long storedBytes = Files.size(target);
            if (storedBytes > MAX_BYTES) {
                deleteQuietly(target);
                throw new SpaceFailure(413, "ASSET_TOO_LARGE", "변환된 이미지가 2MB를 넘어요. 더 작은 이미지를 올려 주세요.");
            }
            UploadResult result = tx.execute(status -> {
                db.queryForList("SELECT id FROM town_space WHERE id=? FOR UPDATE", String.class, spaceId);
                spaces.requireManager(spaceId, userId);
                var duplicates = db.query("SELECT id,status,original_name,thumbnail_key,storage_key,width,height FROM space_asset WHERE space_id=? AND sha256=?",
                    (r, n) -> new ExistingAsset(r.getString("id"), r.getString("status"), r.getString("original_name"),
                        r.getString("thumbnail_key"), r.getString("storage_key"), r.getInt("width"), r.getInt("height")), spaceId, hash);
                if (!duplicates.isEmpty()) {
                    ExistingAsset existing = duplicates.getFirst();
                    if (!"REJECTED".equals(existing.status()))
                        return new UploadResult(view(existing.id(), existing.name(), existing.thumbnailKey(), existing.width(), existing.height(), spaceId, existing.status()), false, null);
                    enforceQuota(spaceId, storedBytes);
                    db.update("""
                        UPDATE space_asset SET uploader_user_id=?,original_name=?,mime_type='image/png',byte_size=?,width=?,height=?,
                            storage_key=?,thumbnail_key=?,status='PENDING',reviewed_by_user_id=NULL,reviewed_at=NULL,created_at=CURRENT_TIMESTAMP(6)
                        WHERE id=? AND space_id=? AND status='REJECTED'
                        """, userId, name, storedBytes, storedImage.getWidth(), storedImage.getHeight(), storageKey, thumbnailKey, existing.id(), spaceId);
                    return new UploadResult(view(existing.id(), name, thumbnailKey, storedImage.getWidth(), storedImage.getHeight(), spaceId, "PENDING"),
                        true, new AssetContent(existing.storageKey(), existing.thumbnailKey(), existing.name()));
                }
                enforceQuota(spaceId, storedBytes);
                db.update("""
                    INSERT INTO space_asset(id,space_id,uploader_user_id,original_name,mime_type,byte_size,width,height,sha256,storage_key,thumbnail_key,status)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,'PENDING')
                """, id, spaceId, userId, name, "image/png", storedBytes, storedImage.getWidth(), storedImage.getHeight(), hash, storageKey, thumbnailKey);
                return new UploadResult(view(id, name, thumbnailKey, storedImage.getWidth(), storedImage.getHeight(), spaceId, "PENDING"), true, null);
            });
            if (!result.inserted()) {
                deleteQuietly(target);
                deleteQuietly(thumbnailTarget);
            }
            if (result.replaced() != null) {
                deleteQuietly(safePath(result.replaced().storageKey()));
                deleteQuietly(safePath(result.replaced().thumbnailKey()));
            }
            return result.asset();
        } catch (SpaceFailure failure) {
            deleteQuietly(temporary); deleteQuietly(target); deleteQuietly(thumbnailTemporary); deleteQuietly(thumbnailTarget); throw failure;
        } catch (Exception failure) {
            deleteQuietly(temporary); deleteQuietly(target); deleteQuietly(thumbnailTemporary); deleteQuietly(thumbnailTarget);
            throw new SpaceFailure(503, "ASSET_STORAGE_UNAVAILABLE", "에셋을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.");
        }
    }

    List<PendingAsset> pending(String spaceId, String userId) {
        spaces.requireOwner(spaceId, userId);
        return db.query("""
            SELECT asset.id,asset.original_name,COALESCE(account.display_name,'탈퇴한 사용자'),asset.width,asset.height,asset.created_at
            FROM space_asset asset LEFT JOIN app_user account ON account.id=asset.uploader_user_id
            WHERE asset.space_id=? AND asset.status='PENDING' ORDER BY asset.created_at,asset.id LIMIT 100
            """, (r, n) -> new PendingAsset(r.getString(1), r.getString(2), r.getString(3), r.getInt(4), r.getInt(5),
                r.getTimestamp(6).getTime(), "/api/v1/spaces/" + spaceId + "/assets/" + r.getString(1) + "/review-content"), spaceId);
    }

    Asset approve(String spaceId, String userId, String assetId) {
        validId(assetId);
        return tx.execute(status -> {
            db.queryForList("SELECT id FROM town_space WHERE id=? FOR UPDATE", String.class, spaceId);
            spaces.requireOwner(spaceId, userId);
            var rows = db.query("SELECT original_name,thumbnail_key,width,height FROM space_asset WHERE id=? AND space_id=? AND status='PENDING' FOR UPDATE",
                (r, n) -> new PendingMetadata(r.getString(1), r.getString(2), r.getInt(3), r.getInt(4)), assetId, spaceId);
            if (rows.isEmpty()) throw new SpaceFailure(404, "ASSET_REVIEW_NOT_FOUND", "승인 대기 중인 에셋을 찾을 수 없어요.");
            db.update("UPDATE space_asset SET status='READY',reviewed_by_user_id=?,reviewed_at=CURRENT_TIMESTAMP(6) WHERE id=? AND space_id=? AND status='PENDING'",
                userId, assetId, spaceId);
            PendingMetadata item = rows.getFirst();
            return view(assetId, item.name(), item.thumbnailKey(), item.width(), item.height(), spaceId, "READY");
        });
    }

    void reject(String spaceId, String userId, String assetId) {
        validId(assetId);
        AssetContent storage = tx.execute(status -> {
            db.queryForList("SELECT id FROM town_space WHERE id=? FOR UPDATE", String.class, spaceId);
            spaces.requireOwner(spaceId, userId);
            var rows = db.query("SELECT storage_key,thumbnail_key,original_name FROM space_asset WHERE id=? AND space_id=? AND status='PENDING' FOR UPDATE",
                (r, n) -> new AssetContent(r.getString(1), r.getString(2), r.getString(3)), assetId, spaceId);
            if (rows.isEmpty()) throw new SpaceFailure(404, "ASSET_REVIEW_NOT_FOUND", "승인 대기 중인 에셋을 찾을 수 없어요.");
            db.update("UPDATE space_asset SET status='REJECTED',reviewed_by_user_id=?,reviewed_at=CURRENT_TIMESTAMP(6) WHERE id=? AND space_id=? AND status='PENDING'",
                userId, assetId, spaceId);
            return rows.getFirst();
        });
        deleteQuietly(safePath(storage.storageKey()));
        deleteQuietly(safePath(storage.thumbnailKey()));
    }

    void delete(String spaceId, String userId, String assetId) {
        spaces.requireManager(spaceId, userId);
        validId(assetId);
        AssetContent storage = tx.execute(status -> {
            db.queryForList("SELECT id FROM town_space WHERE id=? FOR UPDATE", String.class, spaceId);
            spaces.requireManager(spaceId, userId);
            var refs = db.queryForObject("""
                SELECT COUNT(*) FROM map_revision WHERE space_id=? AND (document LIKE ? OR document LIKE ?)
                """, Integer.class, spaceId, "%\"asset\":\"" + assetId + "\"%", "%\"assetId\":\"" + assetId + "\"%");
            var draftRefs = db.queryForObject("SELECT COUNT(*) FROM space_map WHERE space_id=? AND (draft_json LIKE ? OR draft_json LIKE ?)",
                Integer.class, spaceId, "%\"asset\":\"" + assetId + "\"%", "%\"assetId\":\"" + assetId + "\"%");
            if ((refs != null && refs > 0) || (draftRefs != null && draftRefs > 0))
                throw new SpaceFailure(409, "ASSET_IN_USE", "맵에서 사용 중인 에셋은 먼저 제거해 주세요.");
            var keys = db.query("SELECT storage_key,thumbnail_key,original_name FROM space_asset WHERE id=? AND space_id=? AND status IN ('PENDING','READY','REJECTED')",
                (r, n) -> new AssetContent(r.getString("storage_key"), r.getString("thumbnail_key"), r.getString("original_name")), assetId, spaceId);
            if (keys.isEmpty()) throw new SpaceFailure(404, "ASSET_NOT_FOUND", "에셋을 찾을 수 없어요.");
            db.update("DELETE FROM space_asset WHERE id=? AND space_id=?", assetId, spaceId);
            return keys.getFirst();
        });
        deleteQuietly(safePath(storage.storageKey()));
        if (storage.thumbnailKey() != null) deleteQuietly(safePath(storage.thumbnailKey()));
    }

    AssetContent content(String spaceId, String userId, String assetId) {
        spaces.detail(spaceId, userId);
        validId(assetId);
        var rows = db.query("SELECT storage_key,thumbnail_key,original_name FROM space_asset WHERE id=? AND space_id=? AND status='READY'",
            (r, n) -> new AssetContent(r.getString("storage_key"), r.getString("thumbnail_key"), r.getString("original_name")), assetId, spaceId);
        if (rows.isEmpty()) throw new SpaceFailure(404, "ASSET_NOT_FOUND", "에셋을 찾을 수 없어요.");
        AssetContent metadata = rows.getFirst();
        Path path = safePath(metadata.storageKey());
        if (!Files.isRegularFile(path)) throw new SpaceFailure(404, "ASSET_NOT_FOUND", "에셋 파일을 찾을 수 없어요.");
        return metadata;
    }

    AssetContent reviewContent(String spaceId, String userId, String assetId) {
        spaces.requireOwner(spaceId, userId);
        validId(assetId);
        var rows = db.query("SELECT storage_key,thumbnail_key,original_name FROM space_asset WHERE id=? AND space_id=? AND status='PENDING'",
            (r, n) -> new AssetContent(r.getString("storage_key"), r.getString("thumbnail_key"), r.getString("original_name")), assetId, spaceId);
        if (rows.isEmpty()) throw new SpaceFailure(404, "ASSET_REVIEW_NOT_FOUND", "승인 대기 중인 에셋을 찾을 수 없어요.");
        AssetContent metadata = rows.getFirst();
        if (!Files.isRegularFile(safePath(metadata.storageKey()))) throw new SpaceFailure(404, "ASSET_NOT_FOUND", "에셋 파일을 찾을 수 없어요.");
        return metadata;
    }

    void assertReferences(String spaceId, MapDefinition map) {
        var ids = customAssetReferences(map);
        for (String id : ids) {
            Integer count = db.queryForObject("SELECT COUNT(*) FROM space_asset WHERE id=? AND space_id=? AND status='READY'", Integer.class, id, spaceId);
            if (count == null || count != 1)
                throw new SpaceFailure(400, "ASSET_NOT_APPROVED", "승인되지 않았거나 다른 공간의 에셋이 포함되어 있어요.");
        }
    }

    Map<String,String> copyReadyAssets(String sourceSpaceId,String targetSpaceId,String ownerId,List<Path> copiedFiles) {
        var source=db.query("""
            SELECT id,original_name,mime_type,byte_size,width,height,sha256,storage_key,thumbnail_key
            FROM space_asset WHERE space_id=? AND status='READY' ORDER BY created_at,id
            """,(r,n)->new CloneAsset(r.getString("id"),r.getString("original_name"),r.getString("mime_type"),
                r.getLong("byte_size"),r.getInt("width"),r.getInt("height"),r.getString("sha256"),
                r.getString("storage_key"),r.getString("thumbnail_key")),sourceSpaceId);
        Map<String,String> ids=new HashMap<>();
        try {
            for(CloneAsset asset:source){
                String id="custom_"+UUID.randomUUID();
                String storageKey=UUID.randomUUID()+".png";
                String thumbnailKey=asset.thumbnailKey()==null?null:UUID.randomUUID()+".png";
                Path from=safePath(asset.storageKey()),to=safePath(storageKey);
                copyFile(from,to,copiedFiles,asset.byteSize());
                if(thumbnailKey!=null)copyFile(safePath(asset.thumbnailKey()),safePath(thumbnailKey),copiedFiles,-1);
                db.update("""
                    INSERT INTO space_asset(id,space_id,uploader_user_id,original_name,mime_type,byte_size,width,height,sha256,
                        storage_key,thumbnail_key,status,reviewed_by_user_id,reviewed_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,'READY',?,CURRENT_TIMESTAMP(6))
                    """,id,targetSpaceId,ownerId,asset.name(),asset.mimeType(),asset.byteSize(),asset.width(),asset.height(),
                    asset.sha256(),storageKey,thumbnailKey,ownerId);
                ids.put(asset.id(),id);
            }
        } catch(RuntimeException failure) {
            cleanupCloneFiles(copiedFiles);
            throw failure;
        }
        return Map.copyOf(ids);
    }

    void cleanupCloneFiles(List<Path> files) {
        if(files!=null)files.forEach(SpaceAssets::deleteQuietly);
    }

    private void copyFile(Path source,Path target,List<Path> copiedFiles,long expectedBytes) {
        if(!Files.isRegularFile(source))throw new SpaceFailure(503,"ASSET_STORAGE_UNAVAILABLE","복제할 에셋 파일을 찾을 수 없어요.");
        copiedFiles.add(target);
        try {
            Files.copy(source,target);
            if(expectedBytes>=0&&Files.size(target)!=expectedBytes)throw new IOException("Asset size changed during clone");
        } catch(IOException failure) {
            throw new SpaceFailure(503,"ASSET_STORAGE_UNAVAILABLE","에셋을 복사하지 못했어요. 잠시 후 다시 시도해 주세요.");
        }
    }

    Map<String, OfficeCatalog.Asset> definitions(String spaceId, MapDefinition map) {
        var ids = customAssetReferences(map);
        if (ids.isEmpty()) return Map.of();
        String placeholders = String.join(",", Collections.nCopies(ids.size(), "?"));
        List<Object> args = new ArrayList<>();
        args.add(spaceId);
        args.addAll(ids);
        var definitions = db.query("SELECT id,original_name,width,height FROM space_asset WHERE space_id=? AND status='READY' AND id IN (" + placeholders + ")",
            (r, n) -> new OfficeCatalog.Asset(r.getString("id"), r.getString("original_name"), r.getInt("width"), r.getInt("height"), null), args.toArray());
        var result = new HashMap<String, OfficeCatalog.Asset>();
        definitions.forEach(asset -> result.put(asset.id(), asset));
        return Map.copyOf(result);
    }

    private static List<String> customAssetReferences(MapDefinition map) {
        if (map == null || map.objects() == null) return List.of();
        return map.objects().stream().filter(Objects::nonNull)
            .flatMap(object -> java.util.stream.Stream.of(
                object.asset(), object.interaction() == null ? null : object.interaction().assetId()))
            .filter(MapRules::customAssetId).distinct().toList();
    }

    Resource resource(AssetContent metadata, boolean thumbnail) {
        String key = thumbnail && metadata.thumbnailKey() != null ? metadata.thumbnailKey() : metadata.storageKey();
        return new FileSystemResource(safePath(key));
    }
    private Asset view(String id, String name, String thumbnailKey, int width, int height, String spaceId, String status) {
        return new Asset(id, name, "/api/v1/spaces/" + spaceId + "/assets/" + id + "/content",
            "/api/v1/spaces/" + spaceId + "/assets/" + id + "/thumbnail", width, height,
            null, "사용자 에셋", "uploaded", "OBJECT", status);
    }
    private void enforceQuota(String spaceId, long bytes) {
        var totals = db.queryForMap("SELECT COUNT(*) AS asset_count,COALESCE(SUM(byte_size),0) AS total_bytes FROM space_asset WHERE space_id=? AND status IN ('PENDING','READY')", spaceId);
        long totalBytes = ((Number) totals.get("total_bytes")).longValue();
        int assetCount = ((Number) totals.get("asset_count")).intValue();
        if (assetCount >= MAX_ASSETS_PER_SPACE || totalBytes + bytes > MAX_SPACE_BYTES)
            throw new SpaceFailure(413, "ASSET_QUOTA_EXCEEDED", "공간의 에셋 한도(500개 또는 100MB)에 도달했어요.");
    }
    private Path safePath(String key) {
        if (key == null || !key.matches("[0-9a-fA-F-]{36}\\.png")) throw new SpaceFailure(404, "ASSET_NOT_FOUND", "에셋을 찾을 수 없어요.");
        Path path = root.resolve(key).normalize();
        if (!path.startsWith(root)) throw new SpaceFailure(404, "ASSET_NOT_FOUND", "에셋을 찾을 수 없어요.");
        return path;
    }
    private static void validId(String id) {
        if (!MapRules.customAssetId(id)) throw new SpaceFailure(404, "ASSET_NOT_FOUND", "에셋을 찾을 수 없어요.");
    }
    private static String safeName(String value) {
        String name = Optional.ofNullable(value).orElse("사용자 에셋").replaceAll("[\\p{Cntrl}\\\\/]+", "_").strip();
        return name.isBlank() ? "사용자 에셋" : name.substring(0, Math.min(name.length(), 180));
    }
    private static byte[] sha256(byte[] data) {
        try { return MessageDigest.getInstance("SHA-256").digest(data); }
        catch (NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }
    private static BufferedImage decodeBoundedImage(byte[] encoded, String declaredMime) {
        try (ImageInputStream stream = ImageIO.createImageInputStream(new ByteArrayInputStream(encoded))) {
            if (stream == null) throw new IOException("Image stream unavailable");
            Iterator<ImageReader> readers = ImageIO.getImageReaders(stream);
            if (!readers.hasNext()) throw new SpaceFailure(400, "ASSET_INVALID", "지원하지 않는 이미지 형식이에요.");
            ImageReader reader = readers.next();
            try {
                reader.setInput(stream, true, true);
                String format = reader.getFormatName().toLowerCase(Locale.ROOT);
                boolean matchesDeclaredMime = switch (declaredMime) {
                    case "image/png" -> format.equals("png");
                    case "image/jpeg" -> format.equals("jpeg") || format.equals("jpg");
                    default -> false;
                };
                if (!matchesDeclaredMime)
                    throw new SpaceFailure(400, "ASSET_INVALID", "파일 형식과 Content-Type이 일치하지 않아요.");
                int width = reader.getWidth(0), height = reader.getHeight(0);
                if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION
                    || (long) width * height > (long) MAX_DIMENSION * MAX_DIMENSION)
                    throw new SpaceFailure(400, "ASSET_INVALID", "이미지 크기는 가로·세로 1~2048px 범위여야 해요.");
                BufferedImage image = reader.read(0);
                if (image == null) throw new SpaceFailure(400, "ASSET_INVALID", "이미지 파일을 해석할 수 없어요.");
                return image;
            } finally { reader.dispose(); }
        } catch (SpaceFailure failure) { throw failure; }
        catch (IOException | RuntimeException failure) {
            throw new SpaceFailure(400, "ASSET_INVALID", "이미지 파일을 읽을 수 없어요.");
        }
    }
    private static BufferedImage resize(BufferedImage source, int max) {
        double scale = Math.min(1d, Math.min((double) max / source.getWidth(), (double) max / source.getHeight()));
        int width = Math.max(1, (int) Math.round(source.getWidth() * scale));
        int height = Math.max(1, (int) Math.round(source.getHeight() * scale));
        BufferedImage result = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        Graphics2D graphics = result.createGraphics();
        graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_NEAREST_NEIGHBOR);
        graphics.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_SPEED);
        graphics.drawImage(source, 0, 0, width, height, null);
        graphics.dispose();
        return result;
    }
    private static void moveAtomically(Path from, Path to) throws IOException {
        try { Files.move(from, to, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
        catch (AtomicMoveNotSupportedException e) { Files.move(from, to, StandardCopyOption.REPLACE_EXISTING); }
    }
    private static void deleteQuietly(Path path) { try { if (path != null) Files.deleteIfExists(path); } catch (IOException ignored) {} }
    private static BufferedImage thumbnail(BufferedImage source, int max) {
        double scale = Math.min(1d, Math.min((double) max / source.getWidth(), (double) max / source.getHeight()));
        int width = Math.max(1, (int) Math.round(source.getWidth() * scale));
        int height = Math.max(1, (int) Math.round(source.getHeight() * scale));
        BufferedImage result = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        Graphics2D graphics = result.createGraphics();
        graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_NEAREST_NEIGHBOR);
        graphics.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_SPEED);
        graphics.drawImage(source, 0, 0, width, height, null);
        graphics.dispose();
        return result;
    }
    record AssetContent(String storageKey, String thumbnailKey, String originalName) {}
    public record ErasedPendingFile(String storageKey, String thumbnailKey) {}
    private record CloneAsset(String id,String name,String mimeType,long byteSize,int width,int height,String sha256,
                              String storageKey,String thumbnailKey) {}
    private record PendingMetadata(String name, String thumbnailKey, int width, int height) {}
    private record ExistingAsset(String id, String status, String name, String thumbnailKey, String storageKey, int width, int height) {}
    private record UploadResult(Asset asset, boolean inserted, AssetContent replaced) {}

    public List<ErasedPendingFile> rejectPendingUploadsForAccountErasure(String userId) {
        List<ErasedPendingFile> files = db.query("""
            SELECT storage_key,thumbnail_key FROM space_asset
            WHERE uploader_user_id=? AND status='PENDING' FOR UPDATE
            """, (r, n) -> new ErasedPendingFile(r.getString("storage_key"), r.getString("thumbnail_key")), userId);
        if (!files.isEmpty())
            db.update("""
                UPDATE space_asset
                SET status='REJECTED',original_name='탈퇴한 사용자 업로드',uploader_user_id=NULL,
                    reviewed_by_user_id=NULL,reviewed_at=COALESCE(reviewed_at,CURRENT_TIMESTAMP(6))
                WHERE uploader_user_id=? AND status='PENDING'
                """, userId);
        return List.copyOf(files);
    }

    public void deleteErasedPendingFiles(List<ErasedPendingFile> files) {
        for (ErasedPendingFile file : files) {
            deleteStoredFile(file.storageKey());
            deleteStoredFile(file.thumbnailKey());
        }
    }

    @Scheduled(cron = "0 42 4 * * *", zone = "UTC")
    void cleanupRejectedAndAbandonedFiles() {
        sweepRejectedAndAbandonedFiles();
    }

    public int sweepRejectedAndAbandonedFiles() {
        Set<String> retainedKeys = new HashSet<>();
        Set<String> rejectedKeys = new HashSet<>();
        db.query("SELECT storage_key,thumbnail_key,status FROM space_asset", rs -> {
            Set<String> keys = "REJECTED".equals(rs.getString("status")) ? rejectedKeys : retainedKeys;
            addStorageKey(keys, rs.getString("storage_key"));
            addStorageKey(keys, rs.getString("thumbnail_key"));
        });

        int deleted = 0;
        int failed = 0;
        long abandonedBefore = System.currentTimeMillis() - ABANDONED_UPLOAD_AGE_MILLIS;
        try (DirectoryStream<Path> files = Files.newDirectoryStream(root)) {
            for (Path file : files) {
                String name = file.getFileName().toString();
                boolean storedAsset = name.matches("(?i)[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\\.png");
                boolean temporaryUpload = name.matches("(?i)\\.upload(?:-thumb)?-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}");
                if ((!storedAsset && !temporaryUpload) || !Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS))
                    continue;
                if (storedAsset && retainedKeys.contains(name)) continue;
                if (storedAsset && !rejectedKeys.contains(name) && Files.getLastModifiedTime(file).toMillis() >= abandonedBefore)
                    continue;
                if (temporaryUpload && Files.getLastModifiedTime(file).toMillis() >= abandonedBefore)
                    continue;
                try {
                    if (Files.deleteIfExists(file)) deleted++;
                } catch (IOException failure) {
                    failed++;
                }
            }
        } catch (IOException failure) {
            log.warn("Could not scan the asset upload directory for rejected or abandoned files");
            return 0;
        }
        if (deleted > 0 || failed > 0)
            log.info("Asset cleanup removed {} rejected or abandoned files; {} files need another retry", deleted, failed);
        return deleted;
    }

    private static void addStorageKey(Set<String> keys, String key) {
        if (key != null && key.matches("(?i)[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\\.png"))
            keys.add(key);
    }

    private void deleteStoredFile(String key) {
        if (key == null || !key.matches("[0-9a-fA-F-]{36}\\.png")) return;
        Path path = root.resolve(key).normalize();
        if (path.startsWith(root)) deleteQuietly(path);
    }
}
