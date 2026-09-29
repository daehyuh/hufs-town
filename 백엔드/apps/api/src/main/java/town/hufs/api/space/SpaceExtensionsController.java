package town.hufs.api.space;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import town.hufs.auth.TownPrincipal;

import java.util.List;

@RestController
@RequestMapping("/api/v1/spaces/{spaceId}/extensions")
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
class SpaceExtensionsController {
    private final SpaceExtensions extensions;

    SpaceExtensionsController(SpaceExtensions extensions) { this.extensions = extensions; }

    @GetMapping
    List<SpaceExtensions.ExtensionApp> list(@PathVariable String spaceId, @AuthenticationPrincipal TownPrincipal principal) {
        return extensions.list(spaceId, principal);
    }

    @PostMapping
    SpaceExtensions.ExtensionApp register(@PathVariable String spaceId, @AuthenticationPrincipal TownPrincipal principal,
                                          @RequestBody SpaceExtensions.Draft draft) {
        return extensions.register(spaceId, principal, draft);
    }

    @PutMapping("/{extensionId}")
    SpaceExtensions.ExtensionApp update(@PathVariable String spaceId, @PathVariable String extensionId,
                                        @AuthenticationPrincipal TownPrincipal principal,
                                        @RequestBody SpaceExtensions.Draft draft) {
        return extensions.update(spaceId, extensionId, principal, draft);
    }

    @PutMapping("/{extensionId}/permissions")
    SpaceExtensions.ExtensionApp approve(@PathVariable String spaceId, @PathVariable String extensionId,
                                         @AuthenticationPrincipal TownPrincipal principal,
                                         @RequestBody SpaceExtensions.PermissionUpdate update) {
        return extensions.approve(spaceId, extensionId, principal, update);
    }

    @PostMapping("/{extensionId}/enable")
    SpaceExtensions.ExtensionApp enable(@PathVariable String spaceId, @PathVariable String extensionId,
                                        @AuthenticationPrincipal TownPrincipal principal) {
        return extensions.setEnabled(spaceId, extensionId, principal, true);
    }

    @PostMapping("/{extensionId}/disable")
    SpaceExtensions.ExtensionApp disable(@PathVariable String spaceId, @PathVariable String extensionId,
                                         @AuthenticationPrincipal TownPrincipal principal) {
        return extensions.setEnabled(spaceId, extensionId, principal, false);
    }

    @GetMapping("/{extensionId}/context")
    SpaceExtensions.ExtensionContext context(@PathVariable String spaceId, @PathVariable String extensionId,
                                             @AuthenticationPrincipal TownPrincipal principal) {
        return extensions.context(spaceId, extensionId, principal);
    }
}
