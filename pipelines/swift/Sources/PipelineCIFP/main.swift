import Foundation
import SwiftCIFP

// pipeline-cifp <FAACIFP18-file> <out-dir>
//
// Parses the FAA CIFP data file (`FAACIFP18`) via SwiftCIFP and writes
// approaches.json to the output directory. One record per approach
// procedure; the routing engine uses these to filter airports by
// approach type (precision / RNAV / non-precision) at plan time.

@main
struct PipelineCIFP {

  static func main() async throws {
    let args = CommandLine.arguments
    guard args.count == 3 else {
      FileHandle.standardError.write(
        Data("usage: pipeline-cifp <FAACIFP18> <out-dir>\n".utf8))
      exit(2)
    }
    let inURL = URL(fileURLWithPath: args[1])
    let outDir = URL(fileURLWithPath: args[2], isDirectory: true)
    try FileManager.default.createDirectory(
      at: outDir, withIntermediateDirectories: true)

    let cifp = try await CIFP(
      url: inURL,
      errorCallback: { error, line in
        if let line = line {
          FileHandle.standardError.write(
            Data("cifp parse error at line \(line): \(error)\n".utf8))
        }
      })

    var records: [ApproachOut] = []
    for (_, airport) in cifp.airports {
      for ap in airport.approaches {
        records.append(
          ApproachOut(
            airport_id: airport.id,
            identifier: ap.identifier,
            runway_id: ap.runwayId,
            approach_type: String(ap.approachType.rawValue),
            approach_type_label: ap.approachType.description,
            is_precision: ap.isPrecision,
            is_rnav: ap.isRNAV
          ))
      }
    }

    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    try encoder.encode(records)
      .write(to: outDir.appendingPathComponent("approaches.json"))

    FileHandle.standardOutput.write(
      Data("wrote \(records.count) approaches to \(outDir.path)\n".utf8))
  }
}

private struct ApproachOut: Encodable {
  let airport_id: String
  let identifier: String
  let runway_id: String?
  let approach_type: String
  let approach_type_label: String
  let is_precision: Bool
  let is_rnav: Bool
}
