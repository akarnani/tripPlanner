// swift-tools-version:6.0
import PackageDescription

let package = Package(
  name: "trip-planner-pipelines",
  platforms: [.macOS(.v15)],
  products: [
    .executable(name: "pipeline-nasr", targets: ["PipelineNASR"]),
    .executable(name: "pipeline-cifp", targets: ["PipelineCIFP"]),
    .executable(name: "pipeline-dof", targets: ["PipelineDOF"]),
  ],
  dependencies: [
    .package(url: "https://github.com/RISCfuture/SwiftNASR.git", branch: "master"),
    .package(url: "https://github.com/RISCfuture/SwiftCIFP.git", branch: "main"),
    .package(url: "https://github.com/RISCfuture/SwiftDOF.git", branch: "main"),
  ],
  targets: [
    .executableTarget(
      name: "PipelineNASR",
      dependencies: ["SwiftNASR"],
      path: "Sources/PipelineNASR"
    ),
    .executableTarget(
      name: "PipelineCIFP",
      dependencies: ["SwiftCIFP"],
      path: "Sources/PipelineCIFP"
    ),
    .executableTarget(
      name: "PipelineDOF",
      dependencies: ["SwiftDOF"],
      path: "Sources/PipelineDOF"
    ),
  ]
)
