// Carbon copy of the live site's HaloNoteLogo, with only the icon
// glyph swapped for the new brand kit's mark. The wordmark text,
// font stack, sizing, and component API are unchanged so the live
// MarketingNav / MarketingFooter that import these render identically.

interface IconProps {
  size?: number;
  className?: string;
  color?: string;
}

export function HaloNoteLogoIcon({
  size = 40,
  className = "",
  color = "#2663EB",
}: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 387 387"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* Brand kit logo: rounded square tile + white V-and-bracket mark.
          Paths lifted verbatim from
            HaloNote Logo PRESS/Icon_App icon/HaloNote ICON.svg
          (the canonical brand asset). */}
      <rect width="387" height="387" rx="58" fill={color} />
      <path
        d="M124.5 159.4L172.6 0H58C26 0 0 26 0 58v33.4h99.2L124.5 159.4z"
        fill="#FFFFFF"
      />
      <path
        d="M328.4 0H219.3L129 299.4L68.1 136.2H0v192.2c0 32.1 26 58 58 58h109.1L257.4 87l60.9 163.2h68.1V58C386.4 26 360.4 0 328.4 0z"
        fill="#FFFFFF"
      />
      <path
        d="M261.9 227l-48.1 159.4h114.5c32.1 0 58-26 58-58V295h-99.2L261.9 227z"
        fill="#FFFFFF"
      />
    </svg>
  );
}

interface WordmarkProps {
  className?: string;
  fontSize?: number;
  color?: string;
  iconColor?: string;
  showIcon?: boolean;
  showHalo?: boolean;
  align?: "center" | "left";
}

export function HaloNoteWordmark({
  className = "",
  fontSize = 36,
  color = "#000000",
  iconColor = "#000000",
  showIcon = true,
  align = "center",
}: WordmarkProps) {
  const iconSize = Math.round(fontSize * 1.15);

  return (
    <div
      className={`select-none ${className}`}
      style={{
        display: "inline-flex",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: align === "left" ? "flex-start" : "center",
        gap: Math.round(fontSize * 0.4),
      }}
    >
      {showIcon && <HaloNoteLogoIcon size={iconSize} color={iconColor} />}
      <span
        style={{
          fontFamily:
            "'Urbanist', ui-sans-serif, system-ui, -apple-system, sans-serif",
          fontSize: `${fontSize}px`,
          color,
          fontWeight: 700,
          letterSpacing: "-0.01em",
          lineHeight: 1,
          display: "block",
        }}
      >
        HaloNote
      </span>
    </div>
  );
}

export function HaloNoteWordmarkSimple({
  className = "",
  fontSize = 15,
  color = "#000000",
  iconColor = "#000000",
  showIcon = false,
}: {
  className?: string;
  fontSize?: number;
  color?: string;
  iconColor?: string;
  showIcon?: boolean;
}) {
  const iconSize = Math.round(fontSize * 1.6);

  return (
    <div
      className={`select-none inline-flex items-center ${className}`}
      style={{ gap: Math.round(fontSize * 0.5) }}
    >
      {showIcon && <HaloNoteLogoIcon size={iconSize} color={iconColor} />}
      <span
        style={{
          fontFamily:
            "'Urbanist', ui-sans-serif, system-ui, -apple-system, sans-serif",
          fontSize: `${fontSize}px`,
          color,
          fontWeight: 700,
          letterSpacing: "-0.01em",
          lineHeight: 1,
        }}
      >
        HaloNote
      </span>
    </div>
  );
}
