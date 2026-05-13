import Foundation
import SwiftNASR

// pipeline-nasr <distribution.zip> <out-dir>
//
// Reads (or downloads, if missing) an FAA NASR distribution zip, parses the
// airport file, and writes two JSON files to <out-dir>:
//
//   airports.json   one record per public-use airport
//   runways.json    one record per runway, keyed by airport id
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
    try await distribution.parse(.airports) { @Sendable error in
      FileHandle.standardError.write(
        Data("parse warning: \(error)\n".utf8))
      return true
    }

    // `data` is finalized asynchronously after parse.
    let airports = await (distribution.data.airports ?? []).filter {
      $0.publicUse
    }

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

    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]

    try encoder.encode(airportRecs)
      .write(to: outDir.appendingPathComponent("airports.json"))
    try encoder.encode(runwayRecs)
      .write(to: outDir.appendingPathComponent("runways.json"))

    FileHandle.standardOutput.write(
      Data(
        "wrote \(airportRecs.count) airports, \(runwayRecs.count) runways to \(outDir.path)\n"
          .utf8)
    )
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
