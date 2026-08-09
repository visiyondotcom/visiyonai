export default function Logo({ size = 22 }: { size?: number }) {
  // Actual Visiyon AI wordmark (public/logo.png) — a white mark on a
  // transparent background. In light theme the page background turns
  // white too, so the mark needs to render black: invert(1) flips a
  // pure white silhouette to pure black without affecting transparency.
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/logo.png" alt="Visiyon AI" className="[.light_&]:invert" style={{ height: size, width: "auto" }} />
  );
}
