import Foundation
import SwiftDOF

// pipeline-dof <DOF-file> <out-dir>
//
// Parses the FAA Digital Obstacle File via SwiftDOF and writes
// obstacles.json to the output directory. We only retain US obstacles
// 200+ ft AGL — that's the cutoff below which the FAA doesn't require
// individual marking, and it keeps the bundle small.

@main
struct PipelineDOF {

  static func main() async throws {
    let args = CommandLine.arguments
    guard args.count == 3 else {
      FileHandle.standardError.write(
        Data("usage: pipeline-dof <DOF-file> <out-dir>\n".utf8))
      exit(2)
    }
    let inURL = URL(fileURLWithPath: args[1])
    let outDir = URL(fileURLWithPath: args[2], isDirectory: true)
    try FileManager.default.createDirectory(
      at: outDir, withIntermediateDirectories: true)

    let dof = try DOF(url: inURL) { error, line in
      FileHandle.standardError.write(
        Data("dof parse error at line \(line): \(error)\n".utf8))
    }

    var records: [ObstacleOut] = []
    for obstacle in dof {
      if obstacle.heightFtAGL < 200 { continue }
      records.append(
        ObstacleOut(
          id: obstacle.oasNumber,
          state: obstacle.state,
          lat: obstacle.latitudeDeg,
          lon: obstacle.longitudeDeg,
          type: obstacle.type,
          height_agl_ft: obstacle.heightFtAGL,
          height_msl_ft: obstacle.heightFtMSL
        ))
    }

    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    try encoder.encode(records)
      .write(to: outDir.appendingPathComponent("obstacles.json"))

    FileHandle.standardOutput.write(
      Data("wrote \(records.count) obstacles (≥200 ft AGL) to \(outDir.path)\n".utf8))
  }
}

private struct ObstacleOut: Encodable {
  let id: String
  let state: String?
  let lat: Double
  let lon: Double
  let type: String
  let height_agl_ft: Int
  let height_msl_ft: Int
}
