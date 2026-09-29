package town.hufs.api.space;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import town.hufs.auth.TownPrincipal;

@RestController
@RequestMapping("/api/v1/spaces/{spaceId}/room-reservations")
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
class RoomReservationsController {
    private final RoomReservations reservations;

    RoomReservationsController(RoomReservations reservations) { this.reservations = reservations; }

    @GetMapping
    RoomReservations.Snapshot list(@PathVariable String spaceId, @AuthenticationPrincipal TownPrincipal principal) {
        return reservations.list(spaceId, principal);
    }

    @PostMapping
    RoomReservations.Reservation create(@PathVariable String spaceId, @AuthenticationPrincipal TownPrincipal principal,
                                        @RequestBody RoomReservations.Draft draft) {
        return reservations.create(spaceId, principal, draft);
    }

    @PatchMapping("/{reservationId}")
    RoomReservations.Reservation update(@PathVariable String spaceId, @PathVariable String reservationId,
                                        @AuthenticationPrincipal TownPrincipal principal,
                                        @RequestBody RoomReservations.Draft draft) {
        return reservations.update(spaceId, reservationId, principal, draft);
    }

    @DeleteMapping("/{reservationId}")
    RoomReservations.Reservation cancel(@PathVariable String spaceId, @PathVariable String reservationId,
                                        @AuthenticationPrincipal TownPrincipal principal) {
        return reservations.cancel(spaceId, reservationId, principal);
    }
}
