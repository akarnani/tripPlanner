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
    // Pinned by revision SHA so Package.resolved (and therefore the
    // CI build cache key) stays stable across upstream pushes.
    // Bump these intentionally when the upstream changes you want.
    .package(
      url: "https://github.com/RISCfuture/SwiftNASR.git",
      // master @ 2026-09. Must stay at or past d1d1865: the FAA's airport
      // layout effective 2026-09-03 widened the runway Pavement
      // Classification field from 11 to 16 characters, pushing the
      // layout's trailing filler to byte 1536 while APT records still ship
      // 1532 bytes. Earlier revisions sliced that field unconditionally and
      // died on an out-of-range index (SIGILL, exit 133) before writing
      // anything. Needs Swift 6.3 to resolve (StreamingCSV's tools-version).
      revision: "4e289955e9d753f2089f48ffa89870a325e074b1"
    ),
    .package(
      url: "https://github.com/RISCfuture/SwiftCIFP.git",
      revision: "0fdfe20ed157bfd41fe67a5a4666a6278a061c13"  // main @ 2026-05
    ),
    .package(
      url: "https://github.com/RISCfuture/SwiftDOF.git",
      revision: "2a8824bfa9a407b212163e126d68e8e2fa4243fa"  // main @ 2026-05
    ),
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
