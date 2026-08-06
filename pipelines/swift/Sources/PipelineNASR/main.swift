import Foundation
import SwiftNASR

// pipeline-nasr <distribution.zip> <out-dir>
//
// Reads (or downloads, if missing) an FAA NASR distribution zip, parses the
// airport, navaid, and fix files, and writes four JSON files to <out-dir>:
//
//   airports.json   one record per public-use airport
//   runways.json    one record per runway, keyed by airport id
//   navaids.json    one record per operational US VOR-family / NDB navaid
//   fixes.json      one record per US enroute-charted RNAV waypoint
//
// airports.json and runways.json are bare arrays, kept that way for
// backwards compatibility. navaids.json and fixes.json are objects
// carrying the NASR cycle they were built from, because nav data goes
// stale in a way airport data doesn't: the VOR MON program is actively
// decommissioning stations, and fix identifiers get written into GPX /
// FPL exports that a panel GPS on a different AIRAC cycle may fail to
// resolve. The UI surfaces the cycle so a pilot can see the age.
//
// The schema is documented in app/src/data/loaders.ts.

@main
struct PipelineNASR {

  static func main() async throws {
    let args = CommandLine.arguments
    guard args.count == 3 else {
      FileHandle.standardError.write(
        Data("usage: pipeline-nasr <distribution.zip> <out-dir>\n".utf8)
      )
      exit(2)
    }
    let zipURL = URL(fileURLWithPath: args[1])
    let outDir = URL(fileURLWithPath: args[2], isDirectory: true)
    try FileManager.default.createDirectory(
      at: outDir, withIntermediateDirectories: true)

    // fromLocalArchive returns non-optional NASR; fromInternetToFile
    // still returns NASR? (it can fail to construct a loader).
    let distribution: NASR =
      FileManager.default.fileExists(atPath: zipURL.path)
      ? NASR.fromLocalArchive(zipURL)
      : NASR.fromInternetToFile(zipURL)!

    try await distribution.load()
    // parse(_:errorHandler:) returns Bool to indicate "keep going".
    // Must be spelled `Swift.Error`: SwiftNASR declares its own
    // module-scope `Error` enum, and an imported module's declaration
    // shadows the standard library's, so a bare `Error` here names the
    // wrong type and won't convert to parse's errorHandler parameter.
    let keepGoing: @Sendable (Swift.Error) -> Bool = { error in
      FileHandle.standardError.write(
        Data("parse warning: \(error)\n".utf8))
      return true
    }
    try await distribution.parse(.airports, errorHandler: keepGoing)
    try await distribution.parse(.navaids, errorHandler: keepGoing)
    try await distribution.parse(.reportingPoints, errorHandler: keepGoing)

    // `data` is finalized asynchronously after parse.
    let airports = await (distribution.data.airports ?? []).filter {
      $0.publicUse
    }
    let navaids = await distribution.data.navaids ?? []
    let fixes = await distribution.data.fixes ?? []
    // `load()` reads the cycle out of the distribution README; it is
    // already populated by the time parse returns.
    let cycle = await distribution.data.cycle

    var airportRecs: [AirportOut] = []
    var runwayRecs: [RunwayOut] = []
    airportRecs.reserveCapacity(airports.count)

    for ap in airports {
      let lat = Double(ap.referencePoint.latitudeArcsec) / 3600.0
      let lon = Double(ap.referencePoint.longitudeArcsec) / 3600.0
      let elev = ap.referencePoint.elevationFtMSL.map { Int($0.rounded()) }
      let maxRunwayFt = ap.runways
        .compactMap { $0.lengthFt }
        .map { Int($0) }
        .max()
      airportRecs.append(
        AirportOut(
          id: ap.id,
          lid: ap.LID,
          icao: ap.ICAOIdentifier,
          name: ap.name,
          city: ap.city,
          state: ap.stateCode,
          lat: lat,
          lon: lon,
          elevation_ft: elev,
          has_control_tower: ap.controlTower,
          public_use: ap.publicUse,
          runway_count: ap.runways.count,
          max_runway_ft: maxRunwayFt,
          fuels: ap.fuelsAvailable.map { $0.rawValue }
        )
      )
      for rw in ap.runways {
        runwayRecs.append(
          RunwayOut(
            airport_id: ap.id,
            identification: rw.identification,
            length_ft: rw.lengthFt.map { Int($0) },
            width_ft: rw.widthFt.map { Int($0) },
            is_paved: rw.isPaved
          )
        )
      }
    }

    // Navaids: operational VOR-family and NDB-family stations only.
    // `isOperational` covers OPERATIONAL IFR / VFR ONLY / RESTRICTED —
    // filtering on "OPERATIONAL IFR" alone would drop most of the
    // network, since the majority of stations carry the RESTRICTED
    // qualifier. DME-only, TACAN-only, VOT, and marker beacons are
    // excluded: they aren't points a light GA aircraft navigates to.
    var navaidRecs: [NavaidOut] = []
    for nav in navaids where nav.isOperational && (nav.isVOR || nav.isNDB) {
      guard isUS(nav.country) else { continue }
      navaidRecs.append(
        NavaidOut(
          id: nav.id,
          name: nav.name,
          type: nav.type.rawValue,
          lat: Double(nav.position.latitudeArcsec) / 3600.0,
          lon: Double(nav.position.longitudeArcsec) / 3600.0,
          elevation_ft: nav.position.elevationFtMSL.map { Int($0.rounded()) },
          freq_khz: nav.frequencyHz.map { Int($0 / 1000) },
          is_vor: nav.isVOR
        )
      )
    }
    // Sort on a total key. SwiftNASR's parser emits records out of a
    // Dictionary and Swift seeds its hasher per process, so input order
    // differs every run; sorting on `id` alone leaves the 37 duplicated
    // NDB idents free to swap places, which would produce a no-op
    // "Refresh NASR" commit every single week.
    navaidRecs.sort {
      ($0.id, $0.type, $0.lat, $0.lon) < ($1.id, $1.type, $1.lat, $1.lon)
    }

    // Fixes: US RNAV waypoints depicted on an enroute chart. NASR's fix
    // file is dominated by approach-only fixes (~39k charted IAP) which
    // are useless for enroute shaping, so `chartTypes` is the scoping
    // lever. Reporting points (REP-PT) are deliberately excluded — they
    // are enroute-charted too, and re-including them is a one-line
    // change to `use == .waypoint` here if that turns out to be wanted.
    var fixRecs: [FixOut] = []
    for fix in fixes where fix.use == .waypoint {
      guard isUS(fix.country), isEnrouteCharted(fix.chartTypes) else { continue }
      fixRecs.append(
        FixOut(
          id: fix.id,
          lat: Double(fix.position.latitudeArcsec) / 3600.0,
          lon: Double(fix.position.longitudeArcsec) / 3600.0
        )
      )
    }
    fixRecs.sort { ($0.id, $0.lat, $0.lon) < ($1.id, $1.lat, $1.lon) }

    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]

    try encoder.encode(airportRecs)
      .write(to: outDir.appendingPathComponent("airports.json"))
    try encoder.encode(runwayRecs)
      .write(to: outDir.appendingPathComponent("runways.json"))
    try encoder.encode(NavaidFile(cycle: CycleOut(cycle), navaids: navaidRecs))
      .write(to: outDir.appendingPathComponent("navaids.json"))
    try encoder.encode(FixFile(cycle: CycleOut(cycle), fixes: fixRecs))
      .write(to: outDir.appendingPathComponent("fixes.json"))

    FileHandle.standardOutput.write(
      Data(
        """
        wrote \(airportRecs.count) airports, \(runwayRecs.count) runways, \
        \(navaidRecs.count) navaids, \(fixRecs.count) fixes to \(outDir.path)

        """.utf8)
    )
  }

  /// NASR leaves the country field blank for domestic records and fills
  /// in a country *name* for the handful of Canadian, Mexican, and
  /// Pacific-territory entries that ride along in the same files. Treat
  /// blank as domestic.
  ///
  /// The two-letter forms are accepted as well, deliberately. The fix
  /// layout documents field 16 as a country *name*, but the CSV variant
  /// of the same data carries the ISO code, and we can't confirm which
  /// the fixed-width file uses without a live run. Getting that wrong
  /// the strict way is expensive: every fix would be rejected,
  /// fixes.json would come out empty, check_counts.py would trip its
  /// floor, and because the commit step is gated on the run succeeding,
  /// airports and runways would stop being committed too.
  private static func isUS(_ country: String?) -> Bool {
    guard let country else { return true }
    let c = country.trimmingCharacters(in: .whitespaces).uppercased()
    if c.isEmpty { return true }
    return c.contains("UNITED STATES") || c == "US" || c == "USA"
  }

  /// True when a fix is depicted on any enroute chart. NASR spells
  /// these "ENROUTE LOW" / "ENROUTE HIGH"; matching the prefix keeps us
  /// working if the FAA adds another enroute series.
  private static func isEnrouteCharted(_ chartTypes: Set<String>) -> Bool {
    chartTypes.contains { $0.uppercased().hasPrefix("ENROUTE") }
  }
}

// MARK: - Output schema

private struct AirportOut: Encodable {
  let id: String
  let lid: String
  let icao: String?
  let name: String
  let city: String
  let state: String?
  let lat: Double
  let lon: Double
  let elevation_ft: Int?
  let has_control_tower: Bool
  let public_use: Bool
  let runway_count: Int
  let max_runway_ft: Int?
  let fuels: [String]
}

private struct RunwayOut: Encodable {
  let airport_id: String
  let identification: String
  let length_ft: Int?
  let width_ft: Int?
  let is_paved: Bool
}

private struct NavaidOut: Encodable {
  let id: String
  let name: String
  /// NASR facility type verbatim: "VOR", "VOR/DME", "VORTAC", "NDB",
  /// "NDB/DME".
  let type: String
  let lat: Double
  let lon: Double
  let elevation_ft: Int?
  /// VOR frequencies are MHz-scale and NDB frequencies kHz-scale; both
  /// are stored in kHz so one integer field covers the network.
  let freq_khz: Int?
  let is_vor: Bool
}

private struct FixOut: Encodable {
  let id: String
  let lat: Double
  let lon: Double
}

/// Cycle stamp carried by the nav datasets. Dates are ISO-8601 calendar
/// days in UTC; `expires` is the effective date of the following cycle.
private struct CycleOut: Encodable {
  let effective: String?
  let expires: String?

  init(_ cycle: Cycle?) {
    // Cycle's own description is already YYYY-MM-DD.
    effective = cycle?.description
    expires = cycle?.next?.description
  }
}

private struct NavaidFile: Encodable {
  let cycle: CycleOut
  let navaids: [NavaidOut]
}

private struct FixFile: Encodable {
  let cycle: CycleOut
  let fixes: [FixOut]
}
