// macOS Vision으로 이미지 얼굴 감지 — 커버 프레임 선정용 (의존성 0)
// 사용: swift scripts/face-detect.swift <img1> <img2> ...
// 출력: JSON 줄 단위 {"path":..., "faces":[{"x":0.1,"y":0.2,"w":0.3,"h":0.4}], "maxArea":0.12}
// 좌표는 0~1 정규화(Vision 좌표계: y는 아래가 0 — 호출측은 area만 쓰므로 무관)
import Foundation
import Vision
import AppKit

for arg in CommandLine.arguments.dropFirst() {
    guard let image = NSImage(contentsOfFile: arg),
          let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        print("{\"path\":\"\(arg)\",\"faces\":[],\"maxArea\":0,\"error\":\"load\"}")
        continue
    }
    let request = VNDetectFaceRectanglesRequest()
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    do {
        try handler.perform([request])
        let faces = (request.results ?? []).map { obs -> [String: Double] in
            let b = obs.boundingBox
            return ["x": b.origin.x, "y": b.origin.y, "w": b.size.width, "h": b.size.height]
        }
        let maxArea = faces.map { $0["w"]! * $0["h"]! }.max() ?? 0
        let facesJson = faces.map { f in
            String(format: "{\"x\":%.4f,\"y\":%.4f,\"w\":%.4f,\"h\":%.4f}", f["x"]!, f["y"]!, f["w"]!, f["h"]!)
        }.joined(separator: ",")
        print("{\"path\":\"\(arg)\",\"faces\":[\(facesJson)],\"maxArea\":\(String(format: "%.5f", maxArea))}")
    } catch {
        print("{\"path\":\"\(arg)\",\"faces\":[],\"maxArea\":0,\"error\":\"vision\"}")
    }
}
