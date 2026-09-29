package town.hufs.api.space;

final class CollaborativeEditConflict extends RuntimeException {
    final long sequence;
    final SpaceMaps.Editor editor;

    CollaborativeEditConflict(long sequence, SpaceMaps.Editor editor, String message) {
        super(message);
        this.sequence = sequence;
        this.editor = editor;
    }
}
