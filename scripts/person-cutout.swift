// macOS Vision 인물 누끼 — 합성용 깨끗한 알파 매트 (의존성 0)
// 사용: swift scripts/person-cutout.swift <입력이미지> <출력PNG>
// 출력: 인물만 남기고 배경 투명한 RGBA PNG (VNGeneratePersonSegmentationRequest, accurate)
import Foundation
import Vision
import AppKit
import CoreImage

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("usage: person-cutout.swift <in> <out.png>\n".data(using: .utf8)!)
    exit(2)
}
let inPath = args[1], outPath = args[2]

guard let image = NSImage(contentsOfFile: inPath),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("load failed\n".data(using: .utf8)!)
    exit(3)
}

let request = VNGeneratePersonSegmentationRequest()
request.qualityLevel = .accurate
request.outputPixelFormat = kCVPixelFormatType_OneComponent8

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do {
    try handler.perform([request])
    guard let result = request.results?.first else {
        FileHandle.standardError.write("no segmentation\n".data(using: .utf8)!)
        exit(4)
    }
    let maskBuffer = result.pixelBuffer
    let ciImage = CIImage(cgImage: cg)
    var maskCI = CIImage(cvPixelBuffer: maskBuffer)
    // 마스크를 원본 크기로 스케일
    let sx = ciImage.extent.width / maskCI.extent.width
    let sy = ciImage.extent.height / maskCI.extent.height
    maskCI = maskCI.transformed(by: CGAffineTransform(scaleX: sx, y: sy))

    let filter = CIFilter(name: "CIBlendWithMask")!
    filter.setValue(ciImage, forKey: kCIInputImageKey)
    filter.setValue(CIImage.empty(), forKey: kCIInputBackgroundImageKey) // 투명 배경
    filter.setValue(maskCI, forKey: kCIInputMaskImageKey)
    guard let output = filter.outputImage else { exit(5) }

    let ctx = CIContext()
    guard let outCG = ctx.createCGImage(output, from: ciImage.extent) else { exit(6) }
    let rep = NSBitmapImageRep(cgImage: outCG)
    guard let png = rep.representation(using: .png, properties: [:]) else { exit(7) }
    try png.write(to: URL(fileURLWithPath: outPath))
    print("ok \(Int(ciImage.extent.width))x\(Int(ciImage.extent.height))")
} catch {
    FileHandle.standardError.write("vision error: \(error)\n".data(using: .utf8)!)
    exit(8)
}
