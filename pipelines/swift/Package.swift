// swift-tools-version:6.0
import PackageDescription

let package = Package(
  name: "trip-planner-pipelines",
  platforms: [.macOS(.v15)],
  products: [
    .executable(name: "pipeline-nasr", targets: ["PipelineNASR"])
  ],
  dependencies: [
    .package(url: "https://github.com/RISCfuture/SwiftNASR.git", branch: "master")
  ],
  targets: [
    .executableTarget(
      name: "PipelineNASR",
      dependencies: ["SwiftNASR"],
      path: "Sources/PipelineNASR"
    )
  ]
)
