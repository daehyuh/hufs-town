import { AVATAR_CATALOG } from "../generated/avatarCatalog";

export interface AvatarAppearance {
  skin: string;
  clothing: string;
  hair: string;
}

const defaultClothing = ["casual_white", "casual_pink", "casual_green"];

export function Avatar({
  id,
  size = 48,
  appearance,
}: {
  id: number;
  size?: number;
  appearance?: AvatarAppearance;
}) {
  const body = AVATAR_CATALOG.bodyShapes[id] ?? AVATAR_CATALOG.bodyShapes[0];
  const parts = [
    `body-${body}-${appearance?.skin ?? "light"}`,
    `clothing-${body}-${appearance?.clothing ?? defaultClothing[id] ?? "casual_white"}`,
    `hair-${body}-${appearance?.hair ?? "hair_short_black"}`,
  ];
  return (
    <span
      className="pixel-avatar"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {parts.map((part) => (
        <span
          key={part}
          style={{
            backgroundImage: `url(/assets/avatar-parts/${part}.png)`,
            backgroundSize: `${size * 3}px ${size * 4}px`,
            backgroundPosition: `-${size}px 0`,
          }}
        />
      ))}
    </span>
  );
}
