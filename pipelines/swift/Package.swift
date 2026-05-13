// swift-tools-version:6.2
import PackageDescription

let package = Package(
  name: "trip-planner-pipelines",
  // SwiftCIFP and SwiftDOF both declare a macOS 26 minimum (their
  // README/Package.swift say "macOS 26+, iOS 26+, …"). Match them so
  // SwiftPM stops rejecting the executable targets with "requires
  // macOS 15.0 but depends on a product that requires macOS 26.0".
  platforms: [.macOS(.v26)],
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
