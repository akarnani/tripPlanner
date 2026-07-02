/** AirNav airport-detail URL for a display ident (ICAO or LID).
 *  AirNav accepts the same identifier the app shows — e.g.
 *  `airnav.com/airport/KEVW` for an ICAO, `airnav.com/airport/9V5`
 *  for an LID-only field. */
export function airnavUrl(ident: string): string {
  return `https://www.airnav.com/airport/${encodeURIComponent(ident.toUpperCase())}`;
}

interface Props {
  ident: string;
  className?: string;
}

/** An airport ident rendered as a subtle link to its AirNav page,
 *  opened in a new tab. Inherits the surrounding text color and only
 *  underlines on hover, so it reads as plain text in the busy leg
 *  table / chips until you reach for it. `stopPropagation` keeps a
 *  click from also triggering row-level handlers (e.g. the leg row's
 *  profile toggle). */
export function AirportLink({ ident, className }: Props) {
  return (
    <a
      href={airnavUrl(ident)}
      target="_blank"
      rel="noopener noreferrer"
      title={`${ident} on AirNav ↗`}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className={"hover:text-data hover:underline " + (className ?? "")}
    >
      {ident}
    </a>
  );
}
