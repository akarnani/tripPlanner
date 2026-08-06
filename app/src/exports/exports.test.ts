import { afterEach, describe, expect, test, vi } from "vitest";
import type { Airport, NavPoint } from "@/data/loaders";
import type { Aircraft } from "@/data/aircraft";
import type { PlannedRoute } from "@/engine/plan";
import { toGPX } from "./gpx";
import { toFPL } from "./fpl";
import { toPDF } from "./pdf";

function ap(id: string, lat: number, lon: number, icao: string | null): Airport {
  return {
    id,
    lid: id,
    icao,
    name: `${id} airport`,
    city: "",
    state: null,
    lat,
    lon,
    elevation_ft: 100,
    has_control_tower: false,
    public_use: true,
    runway_count: 1,
    max_runway_ft: 5000,
    fuels: [],
  };
}

/** Real NASR values: a VORTAC (116.80 MHz, stored as kHz), an enroute
 *  fix with no name and nothing to tune, and an NDB whose frequency is
 *  kHz on the nose. */
const SEA: NavPoint = {
  id: "nav:SEA",
  ident: "SEA",
  kind: "navaid",
  lat: 47.43537326388889,
  lon: -122.30961805555556,
  name: "SEATTLE",
  type: "VORTAC",
  freq_khz: 116800,
};
const HAROB: NavPoint = {
  id: "fix:HAROB",
  ident: "HAROB",
  kind: "fix",
  lat: 46.5,
  lon: -120.5,
};
const AA: NavPoint = {
  id: "nav:AA",
  ident: "AA",
  kind: "navaid",
  lat: 47.009053819444446,
  lon: -96.81518229166667,
  name: "KENIE",
  type: "NDB",
  freq_khz: 365,
};

/** KSEA → KGEG → KBOI. With `via` arguments the legs are shaped through
 *  nav points; with none, they are plain great circles. */
function mkRoute(via1?: NavPoint[], via2?: NavPoint[]): PlannedRoute {
  const a = ap("A", 47.45, -122.31, "KSEA");
  const b = ap("B", 47.62, -117.53, "KGEG");
  const c = ap("C", 43.56, -116.22, "KBOI");
  return {
    costFnId: "totalTime",
    cost: 2,
    legs: [
      {
        from: "A",
        to: "B",
        distance_nm: 224,
        time_hr: 1.9,
        fuel_gal: 18,
        true_course_deg: 90,
        magnetic_course_deg: 75,
        variation_deg: 15,
        cruise_alt_ft: 7500,
        tas_kt: 120,
        fuel_gph: 9,
        fromAirport: a,
        toAirport: b,
        ...(via1 ? { via: via1 } : {}),
      },
      {
        from: "B",
        to: "C",
        distance_nm: 268,
        time_hr: 2.3,
        fuel_gal: 22,
        true_course_deg: 180,
        magnetic_course_deg: 165,
        variation_deg: 15,
        cruise_alt_ft: 6500,
        tas_kt: 117,
        fuel_gph: 7.6,
        fromAirport: b,
        toAirport: c,
        ...(via2 ? { via: via2 } : {}),
      },
    ],
    totals: { distance_nm: 492, time_hr: 4.2, fuel_gal: 40, stops: 1 },
  };
}

const AIRCRAFT = {
  slug: "c172",
  make: "Cessna",
  model: "172",
  fuel: { type: "100LL", density_lb_per_gal: 6, usable_capacity_gal: 40 },
  cruise: [],
  climb: { rate_fpm: 700, fuel_to_climb_gph: 12 },
} as unknown as Aircraft;

/**
 * The text jsPDF actually drew, as "x,y text" in drawing order. jsPDF
 * writes an uncompressed content stream of WinAnsi strings, so the page
 * can be read back without a PDF parser — and reading the positions too
 * means a column silently sliding sideways fails the test.
 */
async function pdfLines(blob: Blob): Promise<string[]> {
  const raw = new TextDecoder("latin1").decode(
    new Uint8Array(await blob.arrayBuffer()),
  );
  return [...raw.matchAll(/([-\d.]+) ([-\d.]+) Td\s*\((.*?)\) Tj/g)].map(
    (m) =>
      `${Math.round(Number(m[1]))},${Math.round(Number(m[2]))} ` +
      m[3].replace(/\\([()\\])/g, "$1"),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("toGPX", () => {
  test("emits one <rtept> per airport in order with ICAO identifiers", () => {
    const gpx = toGPX(mkRoute(), "Test");
    expect(gpx).toMatch(/<gpx /);
    const matches = gpx.match(/<rtept /g) ?? [];
    expect(matches).toHaveLength(3);
    expect(gpx).toContain("<name>KSEA</name>");
    expect(gpx).toContain("<name>KGEG</name>");
    expect(gpx).toContain("<name>KBOI</name>");
    expect(gpx.indexOf("KSEA")).toBeLessThan(gpx.indexOf("KGEG"));
    expect(gpx.indexOf("KGEG")).toBeLessThan(gpx.indexOf("KBOI"));
  });

  test("interleaves a shaped leg's nav points between the airports", () => {
    const gpx = toGPX(mkRoute([SEA, HAROB], [AA]), "Test");
    expect(gpx.match(/<rtept /g) ?? []).toHaveLength(6);
    const order = ["KSEA", "SEA", "HAROB", "KGEG", "AA", "KBOI"].map((id) =>
      gpx.indexOf(`<name>${id}</name>`),
    );
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(order.every((i) => i >= 0)).toBe(true);
  });

  test("gives nav points a facility <sym> and no <ele> at all", () => {
    const gpx = toGPX(mkRoute([SEA, HAROB], [AA]), "Test");
    // No <ele>0</ele>: a NavPoint carries no elevation, and putting a
    // mountain VORTAC at sea level is a claim the receiver may act on.
    expect(gpx).toContain(
      [
        `    <rtept lat="47.43537326388889" lon="-122.30961805555556">`,
        `      <name>SEA</name>`,
        `      <desc>SEA VORTAC</desc>`,
        `      <sym>VOR</sym>`,
        `    </rtept>`,
      ].join("\n"),
    );
    expect(gpx).toContain(
      [
        `    <rtept lat="46.5" lon="-120.5">`,
        `      <name>HAROB</name>`,
        `      <desc>HAROB</desc>`,
        `      <sym>Intersection</sym>`,
        `    </rtept>`,
      ].join("\n"),
    );
    expect(gpx).toContain(`      <sym>NDB</sym>`);
    // Airports keep theirs.
    expect(gpx.match(/<ele>/g) ?? []).toHaveLength(3);
  });
});

describe("toFPL", () => {
  test("emits a waypoint table and a route-point per airport", () => {
    const fpl = toFPL(mkRoute(), "Test");
    expect(fpl).toMatch(/<flight-plan /);
    const wpMatches = fpl.match(/<waypoint>/g) ?? [];
    expect(wpMatches).toHaveLength(3);
    const rpMatches = fpl.match(/<route-point>/g) ?? [];
    expect(rpMatches).toHaveLength(3);
    expect(fpl).toContain("<identifier>KSEA</identifier>");
    expect(fpl).toContain("<waypoint-identifier>KBOI</waypoint-identifier>");
  });

  test("falls back to FAA LID when ICAO is missing", () => {
    const a = ap("X1", 40, -120, null);
    const b = ap("X2", 41, -121, null);
    const route: PlannedRoute = {
      costFnId: "totalTime",
      cost: 1,
      legs: [
        {
          from: "X1",
          to: "X2",
          distance_nm: 50,
          time_hr: 0.5,
          fuel_gal: 5,
          true_course_deg: 45,
          magnetic_course_deg: 45,
          variation_deg: null,
          cruise_alt_ft: 3500,
          tas_kt: 120,
          fuel_gph: 9,
          fromAirport: a,
          toAirport: b,
        },
      ],
      totals: { distance_nm: 50, time_hr: 0.5, fuel_gal: 5, stops: 0 },
    };
    const fpl = toFPL(route);
    expect(fpl).toContain("<identifier>X1</identifier>");
    expect(fpl).toContain("<identifier>X2</identifier>");
  });

  test("types a VOR waypoint and carries its frequency in MHz", () => {
    const fpl = toFPL(mkRoute([SEA, HAROB], [AA]), "Test");
    // 116800 kHz in NASR is 116.80 MHz on the chart. The frequency sits
    // in <extensions> because Garmin's Waypoint_t sequence has no
    // element for it and a loose one fails validation.
    expect(fpl).toContain(
      [
        `    <waypoint>`,
        `      <identifier>SEA</identifier>`,
        `      <type>VOR</type>`,
        `      <country-code>US</country-code>`,
        `      <lat>47.43537326388889</lat>`,
        `      <lon>-122.30961805555556</lon>`,
        `      <comment>SEA VORTAC</comment>`,
        `      <extensions>`,
        `        <frequency xmlns="urn:trip-planner:flight-plan:v1" units="MHz">116.80</frequency>`,
        `      </extensions>`,
        `    </waypoint>`,
      ].join("\n"),
    );
  });

  test("types a fix as INT and an NDB as NDB, neither with a frequency", () => {
    const fpl = toFPL(mkRoute([SEA, HAROB], [AA]), "Test");
    expect(fpl).toContain(
      [
        `      <identifier>HAROB</identifier>`,
        `      <type>INT</type>`,
        `      <country-code>US</country-code>`,
        `      <lat>46.5</lat>`,
        `      <lon>-120.5</lon>`,
        `      <comment>HAROB</comment>`,
        `    </waypoint>`,
      ].join("\n"),
    );
    // 365 kHz is not 0.365 MHz; the ADF frequency stays out rather than
    // going in under the unit this field is read as.
    expect(fpl).toContain(
      [
        `      <identifier>AA</identifier>`,
        `      <type>NDB</type>`,
        `      <country-code>US</country-code>`,
        `      <lat>47.009053819444446</lat>`,
        `      <lon>-96.81518229166667</lon>`,
        `      <comment>AA NDB</comment>`,
        `    </waypoint>`,
      ].join("\n"),
    );
    expect(fpl.match(/<frequency[ >]/g) ?? []).toHaveLength(1);
    expect(fpl.match(/<extensions>/g) ?? []).toHaveLength(1);
  });

  test("route-points name every waypoint, typed, in flown order", () => {
    const fpl = toFPL(mkRoute([SEA, HAROB], [AA]), "Test");
    const route = fpl.slice(fpl.indexOf("<route>"));
    const flown = [...route.matchAll(/<waypoint-identifier>([^<]+)</g)].map(
      (m) => m[1],
    );
    expect(flown).toEqual(["KSEA", "SEA", "HAROB", "KGEG", "AA", "KBOI"]);
    const types = [...route.matchAll(/<waypoint-type>([^<]+)</g)].map(
      (m) => m[1],
    );
    expect(types).toEqual(["AIRPORT", "VOR", "INT", "AIRPORT", "NDB", "AIRPORT"]);
  });

  test("keeps an airport and a same-ident navaid as separate waypoints", () => {
    // 479 navaids share an ident with an airport. Here the trip lands at
    // BOI and overflies the BOI VORTAC: two waypoints, two types.
    const boiVor: NavPoint = {
      id: "nav:BOI",
      ident: "BOI",
      kind: "navaid",
      lat: 43.55,
      lon: -116.19,
      name: "BOISE",
      type: "VORTAC",
      freq_khz: 113300,
    };
    const route = mkRoute([boiVor]);
    route.legs[0].toAirport = ap("BOI", 43.56, -116.22, null);
    route.legs[1].fromAirport = route.legs[0].toAirport;
    const fpl = toFPL(route, "Test");
    expect(fpl.match(/<waypoint>/g) ?? []).toHaveLength(4);
    expect(fpl).toContain(
      `      <identifier>BOI</identifier>\n      <type>VOR</type>`,
    );
    expect(fpl).toContain(
      `      <identifier>BOI</identifier>\n      <type>AIRPORT</type>`,
    );
  });
});

describe("toPDF", () => {
  test("puts nav points in the route line and marks them as overflies", async () => {
    const lines = await pdfLines(
      toPDF({
        route: mkRoute([SEA, HAROB], [AA]),
        aircraft: AIRCRAFT,
        terrain: null,
      }),
    );
    expect(lines).toContain(
      "48,722 KSEA  >  SEA VORTAC  >  HAROB  >  KGEG  >  AA NDB  >  KBOI",
    );
    // Indented under their leg, never in a From/To cell: a shape point
    // is flown over, not landed at.
    expect(lines).toContain("58,624 via SEA VORTAC, HAROB (overfly)");
    expect(lines).toContain("58,598 via AA NDB (overfly)");
    expect(lines).toContain("48,638 KSEA");
    expect(lines).toContain("108,638 KGEG");
  });
});

/**
 * A route with no shape points has to serialise exactly as it did
 * before nav points existed — pilots have these files on their tablets
 * and panel GPSs, and a gratuitous change is a re-import for everyone.
 */
describe("legs without via", () => {
  test("produce byte-identical GPX", () => {
    expect(toGPX(mkRoute(), "Test")).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="trip-planner" xmlns="http://www.topografix.com/GPX/1/1">
  <rte>
    <name>Test</name>
    <rtept lat="47.45" lon="-122.31">
      <ele>30.48</ele>
      <name>KSEA</name>
      <desc>A airport</desc>
    </rtept>
    <rtept lat="47.62" lon="-117.53">
      <ele>30.48</ele>
      <name>KGEG</name>
      <desc>B airport</desc>
    </rtept>
    <rtept lat="43.56" lon="-116.22">
      <ele>30.48</ele>
      <name>KBOI</name>
      <desc>C airport</desc>
    </rtept>
  </rte>
</gpx>
`,
    );
  });

  test("produce byte-identical FPL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T12:00:00.000Z"));
    expect(toFPL(mkRoute(), "Test")).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>
<flight-plan xmlns="http://www8.garmin.com/xmlschemas/FlightPlan/v1">
  <created>2026-08-06T12:00:00.000Z</created>
  <waypoint-table>
    <waypoint>
      <identifier>KSEA</identifier>
      <type>AIRPORT</type>
      <country-code>US</country-code>
      <lat>47.45</lat>
      <lon>-122.31</lon>
      <comment>A airport</comment>
    </waypoint>
    <waypoint>
      <identifier>KGEG</identifier>
      <type>AIRPORT</type>
      <country-code>US</country-code>
      <lat>47.62</lat>
      <lon>-117.53</lon>
      <comment>B airport</comment>
    </waypoint>
    <waypoint>
      <identifier>KBOI</identifier>
      <type>AIRPORT</type>
      <country-code>US</country-code>
      <lat>43.56</lat>
      <lon>-116.22</lon>
      <comment>C airport</comment>
    </waypoint>
  </waypoint-table>
  <route>
    <route-name>Test</route-name>
    <flight-plan-index>1</flight-plan-index>
    <route-point>
      <waypoint-identifier>KSEA</waypoint-identifier>
      <waypoint-type>AIRPORT</waypoint-type>
      <waypoint-country-code>US</waypoint-country-code>
    </route-point>
    <route-point>
      <waypoint-identifier>KGEG</waypoint-identifier>
      <waypoint-type>AIRPORT</waypoint-type>
      <waypoint-country-code>US</waypoint-country-code>
    </route-point>
    <route-point>
      <waypoint-identifier>KBOI</waypoint-identifier>
      <waypoint-type>AIRPORT</waypoint-type>
      <waypoint-country-code>US</waypoint-country-code>
    </route-point>
  </route>
</flight-plan>
`,
    );
  });

  test("produce an unchanged PDF page", async () => {
    // The PDF itself can't be compared byte for byte (jsPDF stamps a
    // creation date), so compare every string it drew and where.
    const lines = await pdfLines(
      toPDF({ route: mkRoute(), aircraft: AIRCRAFT, terrain: null }),
    );
    expect(lines).toEqual([
      "48,744 Flight plan kneeboard",
      "48,722 KSEA  >  KGEG  >  KBOI",
      "48,704 Aircraft: Cessna 172",
      "48,690 Total: 492 nm  ·  4.2 hr  ·  40.0 gal  ·  1 stop",
      "48,668 Legs",
      "48,654 From",
      "108,654 To",
      "176,654 Alt",
      "233,654 MC",
      "283,654 NM",
      "336,654 Time",
      "399,654 Fuel",
      "48,638 KSEA",
      "108,638 KGEG",
      "163,638 7,500",
      "228,638 075°",
      "282,638 224",
      "333,638 114m",
      "399,638 18.0",
      "48,624 KGEG",
      "108,624 KBOI",
      "163,624 6,500",
      "228,624 165°",
      "282,624 268",
      "333,624 138m",
      "399,624 22.0",
    ]);
  });
});
