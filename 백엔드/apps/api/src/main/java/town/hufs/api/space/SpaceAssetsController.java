package town.hufs.api.space;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.io.Resource;
import org.springframework.http.*;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import town.hufs.auth.TownPrincipal;
import java.util.List;

@RestController
@RequestMapping("/api/v1/spaces/{spaceId}/assets")
@ConditionalOnProperty(name="town.auth.mode", havingValue="sso", matchIfMissing=true)
class SpaceAssetsController {
    private final SpaceAssets assets;
    SpaceAssetsController(SpaceAssets assets) { this.assets = assets; }

    @GetMapping List<SpaceAssets.Asset> list(@PathVariable String spaceId, @AuthenticationPrincipal TownPrincipal principal) {
        return assets.list(spaceId, principal.userId());
    }

    @PostMapping(consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    SpaceAssets.Asset upload(@PathVariable String spaceId, @AuthenticationPrincipal TownPrincipal principal,
                             @RequestPart("file") MultipartFile file) {
        return assets.upload(spaceId, principal.userId(), file);
    }

    @GetMapping("/review")
    List<SpaceAssets.PendingAsset> pending(@PathVariable String spaceId, @AuthenticationPrincipal TownPrincipal principal) {
        return assets.pending(spaceId, principal.userId());
    }

    @PostMapping("/{assetId}/approve")
    SpaceAssets.Asset approve(@PathVariable String spaceId, @PathVariable String assetId,
                              @AuthenticationPrincipal TownPrincipal principal) {
        return assets.approve(spaceId, principal.userId(), assetId);
    }

    @PostMapping("/{assetId}/reject")
    java.util.Map<String, Boolean> reject(@PathVariable String spaceId, @PathVariable String assetId,
                                          @AuthenticationPrincipal TownPrincipal principal) {
        assets.reject(spaceId, principal.userId(), assetId);
        return java.util.Map.of("rejected", true);
    }

    @DeleteMapping("/{assetId}")
    java.util.Map<String, Boolean> delete(@PathVariable String spaceId, @PathVariable String assetId,
                                          @AuthenticationPrincipal TownPrincipal principal) {
        assets.delete(spaceId, principal.userId(), assetId);
        return java.util.Map.of("deleted", true);
    }

    @GetMapping("/{assetId}/content")
    ResponseEntity<Resource> content(@PathVariable String spaceId, @PathVariable String assetId,
                                     @AuthenticationPrincipal TownPrincipal principal) {
        var metadata = assets.content(spaceId, principal.userId(), assetId);
        return ResponseEntity.ok().cacheControl(CacheControl.noCache()).contentType(MediaType.IMAGE_PNG)
            .header(HttpHeaders.CONTENT_DISPOSITION, ContentDisposition.inline().filename(metadata.originalName()).build().toString())
            .body(assets.resource(metadata, false));
    }

    @GetMapping("/{assetId}/thumbnail")
    ResponseEntity<Resource> thumbnail(@PathVariable String spaceId, @PathVariable String assetId,
                                       @AuthenticationPrincipal TownPrincipal principal) {
        var metadata = assets.content(spaceId, principal.userId(), assetId);
        return ResponseEntity.ok().cacheControl(CacheControl.noCache()).contentType(MediaType.IMAGE_PNG)
            .header(HttpHeaders.CONTENT_DISPOSITION, ContentDisposition.inline().filename(metadata.originalName()).build().toString())
            .body(assets.resource(metadata, true));
    }

    @GetMapping("/{assetId}/review-content")
    ResponseEntity<Resource> reviewContent(@PathVariable String spaceId, @PathVariable String assetId,
                                           @AuthenticationPrincipal TownPrincipal principal) {
        var metadata = assets.reviewContent(spaceId, principal.userId(), assetId);
        return ResponseEntity.ok().cacheControl(CacheControl.noCache()).contentType(MediaType.IMAGE_PNG)
            .header(HttpHeaders.CONTENT_DISPOSITION, ContentDisposition.inline().filename(metadata.originalName()).build().toString())
            .body(assets.resource(metadata, true));
    }
}
