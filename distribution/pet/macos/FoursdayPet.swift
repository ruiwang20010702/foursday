import AppKit
import Observation
import SwiftUI

private struct StatusEnvelope: Decodable {
    struct Gateway: Decodable {
        let mode: String
        let sendEnabled: Bool
        let checkpointState: String
        let running: Bool?
        let sendBlocked: Bool?
        let modeConsistent: Bool?
    }
    let ready: Bool
    let gateway: Gateway
}

private struct TasksEnvelope: Decodable {
    let items: [TaskItem]
}

private struct TaskItem: Decodable, Identifiable {
    struct Contract: Decodable {
        let title: String
        let goal: String
        let lifecycleState: String
        let acceptanceCriteria: [String]
        let evidenceCounts: [String: Int]
    }
    let taskId: String
    let projectId: String?
    let state: String
    let updatedAt: String?
    let pendingIntervention: PendingIntervention?
    let taskContract: Contract?
    var id: String { taskId }
}

private struct PendingIntervention: Decodable {
    let type: String
    let createdAt: String
}

private enum PetAnimationState: String {
    case idle
    case runningRight = "running-right"
    case runningLeft = "running-left"
    case waving
    case jumping
    case failed
    case waiting
    case working
    case review

    var row: Int {
        switch self {
        case .idle: 0
        case .runningRight: 1
        case .runningLeft: 2
        case .waving: 3
        case .jumping: 4
        case .failed: 5
        case .waiting: 6
        case .working: 7
        case .review: 8
        }
    }

    var frameLimit: Int {
        switch self {
        case .idle: 1
        case .runningRight, .runningLeft, .failed: 8
        case .waving: 4
        case .jumping: 5
        case .waiting, .working, .review: 6
        }
    }
}

private struct PetAtlas {
    let name: String
    let image: CGImage
    let rows: Int
    let populatedColumns: [[Int]]
    let columns = 8

    func frame(row: Int, column: Int) -> CGImage? {
        let cellWidth = image.width / columns
        let cellHeight = image.height / rows
        guard cellWidth > 0, cellHeight > 0 else { return nil }
        let boundedRow = min(max(row, 0), rows - 1)
        let boundedColumn = min(max(column, 0), columns - 1)
        return image.cropping(to: CGRect(
            x: boundedColumn * cellWidth,
            y: boundedRow * cellHeight,
            width: cellWidth,
            height: cellHeight
        ))
    }

    func animationColumns(for state: PetAnimationState) -> [Int] {
        guard populatedColumns.indices.contains(state.row) else { return [0] }
        let visible = populatedColumns[state.row].filter { $0 < state.frameLimit }
        return visible.isEmpty ? [0] : visible
    }

    static func load() -> PetAtlas? {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let root = home.appending(path: ".codex/pets", directoryHint: .isDirectory)
        let preferred = preferredPetId(home: home)
        let directories = (try? FileManager.default.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )) ?? []
        let ordered = directories.sorted { left, right in
            if left.lastPathComponent == preferred { return true }
            if right.lastPathComponent == preferred { return false }
            return left.lastPathComponent < right.lastPathComponent
        }
        for directory in ordered {
            let manifest = directory.appending(path: "pet.json")
            let sheet = directory.appending(path: "spritesheet.webp")
            guard
                let data = try? Data(contentsOf: manifest),
                let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let nsImage = NSImage(contentsOf: sheet),
                let cgImage = nsImage.cgImage(forProposedRect: nil, context: nil, hints: nil)
            else { continue }
            let rows = cgImage.height % 11 == 0 ? 11 : 9
            guard cgImage.width % 8 == 0, cgImage.height % rows == 0 else { continue }
            return PetAtlas(
                name: (json["displayName"] as? String) ?? directory.lastPathComponent,
                image: cgImage,
                rows: rows,
                populatedColumns: scanPopulatedColumns(in: cgImage, rows: rows)
            )
        }
        return nil
    }

    private static func preferredPetId(home: URL) -> String? {
        if let override = ProcessInfo.processInfo.environment["FOURSDAY_PET_ID"], !override.isEmpty {
            return override
        }
        let config = home.appending(path: ".codex/config.toml")
        guard let contents = try? String(contentsOf: config, encoding: .utf8) else { return nil }
        for rawLine in contents.split(whereSeparator: \.isNewline) {
            let line = rawLine.split(separator: "#", maxSplits: 1).first?.trimmingCharacters(in: .whitespaces) ?? ""
            guard line.hasPrefix("selected-avatar-id"), let separator = line.firstIndex(of: "=") else { continue }
            let value = line[line.index(after: separator)...]
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
            return value.hasPrefix("custom:") ? String(value.dropFirst("custom:".count)) : nil
        }
        return nil
    }

    private static func scanPopulatedColumns(in image: CGImage, rows: Int) -> [[Int]] {
        let cellWidth = image.width / 8
        let cellHeight = image.height / rows
        return (0..<rows).map { row in
            (0..<8).filter { column in
                guard let cell = image.cropping(to: CGRect(
                    x: column * cellWidth,
                    y: row * cellHeight,
                    width: cellWidth,
                    height: cellHeight
                )) else { return false }
                return hasVisiblePixels(cell)
            }
        }
    }

    private static func hasVisiblePixels(_ image: CGImage) -> Bool {
        var rgba = [UInt8](repeating: 0, count: image.width * image.height * 4)
        guard let context = CGContext(
            data: &rgba,
            width: image.width,
            height: image.height,
            bitsPerComponent: 8,
            bytesPerRow: image.width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return true }
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return stride(from: 3, to: rgba.count, by: 4).contains { rgba[$0] > 0 }
    }
}

@MainActor @Observable
private final class PetModel {
    var status: StatusEnvelope?
    var tasks: [TaskItem] = []
    var expanded = false {
        didSet { onExpansionChanged?(expanded) }
    }
    var lastError: String?
    let atlas = PetAtlas.load()
    var onExpansionChanged: ((Bool) -> Void)?
    var onDragChanged: ((CGSize) -> Void)?
    var onDragEnded: (() -> Void)?
    private var dashboardProcess: Process?
    private var refreshTask: Task<Void, Never>?
    private var motionResetTask: Task<Void, Never>?
    private var interactionState: PetAnimationState?
    private var isHovering = false
    private var hasLoadedTasks = false

    var workState: PetAnimationState {
        guard lastError == nil else { return .failed }
        guard let status else { return .waiting }
        if status.gateway.sendBlocked == true || status.gateway.modeConsistent == false {
            return .failed
        }
        if ["failed", "error", "blocked", "unknown_send"].contains(status.gateway.checkpointState) {
            return .failed
        }
        if tasks.contains(where: { $0.taskContract?.lifecycleState == "failed" }) { return .failed }
        if tasks.contains(where: { $0.taskContract?.lifecycleState == "waiting_acceptance" }) { return .review }
        if tasks.contains(where: { item in
            item.pendingIntervention != nil || ["escalated", "rework_requested"].contains(item.taskContract?.lifecycleState)
        }) { return .waiting }
        if status.gateway.mode != "active" || !status.gateway.sendEnabled || status.gateway.running != true {
            return .idle
        }
        return tasks.contains(where: { $0.state == "active" }) ? .working : .idle
    }

    var animationState: PetAnimationState {
        interactionState ?? workState
    }

    var attentionCount: Int {
        tasks.filter { item in
            item.state != "taken_over" && (
                item.pendingIntervention != nil ||
                ["waiting_acceptance", "escalated", "rework_requested", "failed"].contains(item.taskContract?.lifecycleState)
            )
        }.count
    }

    func start() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            guard let self else { return }
            await ensureDashboard()
            while !Task.isCancelled {
                await refresh()
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }

    func stop() {
        refreshTask?.cancel()
        refreshTask = nil
        motionResetTask?.cancel()
        motionResetTask = nil
        if dashboardProcess?.isRunning == true { dashboardProcess?.terminate() }
        dashboardProcess = nil
    }

    func setHovering(_ hovering: Bool) {
        let entered = hovering && !isHovering
        isHovering = hovering
        if entered {
            trigger(.waving, for: .milliseconds(840))
        } else if !hovering && interactionState == .waving {
            motionResetTask?.cancel()
            interactionState = nil
        }
    }

    func petTapped() {
        trigger(.jumping, for: .milliseconds(850))
        expanded.toggle()
    }

    func dragChanged(_ translation: CGSize) {
        motionResetTask?.cancel()
        interactionState = translation.width < 0 ? .runningLeft : .runningRight
        onDragChanged?(translation)
    }

    func dragEnded() {
        interactionState = nil
        onDragEnded?()
    }

    private func ensureDashboard() async {
        if await dashboardAvailable() { return }
        guard let executable = locateFoursday() else {
            lastError = "找不到 foursday 命令"
            return
        }
        let process = Process()
        process.executableURL = executable
        process.arguments = ["dashboard", "--port", "9466"]
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        do {
            try process.run()
            dashboardProcess = process
            for _ in 0..<30 {
                if await dashboardAvailable() { return }
                try? await Task.sleep(for: .milliseconds(200))
            }
            lastError = "任务服务启动超时"
        } catch {
            lastError = "任务服务启动失败"
        }
    }

    private func locateFoursday() -> URL? {
        let environment = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [
            environment["FOURSDAY_CLI_PATH"],
            home + "/.local/bin/foursday",
            "/opt/homebrew/bin/foursday",
            "/usr/local/bin/foursday",
        ].compactMap { $0 }
        return candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }).map(URL.init(fileURLWithPath:))
    }

    private func dashboardAvailable() async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:9466/api/status") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1
        return (try? await URLSession.shared.data(for: request).1 as? HTTPURLResponse)?.statusCode == 200
    }

    private func refresh() async {
        do {
            async let nextStatus: StatusEnvelope = read("status")
            async let nextTasks: TasksEnvelope = read("tasks")
            let refreshedStatus = try await nextStatus
            let refreshedTasks = try await nextTasks.items
            if hasLoadedTasks {
                celebrateTaskTransitions(from: tasks, to: refreshedTasks)
            }
            status = refreshedStatus
            tasks = refreshedTasks
            hasLoadedTasks = true
            lastError = nil
        } catch {
            lastError = "任务状态暂不可用"
        }
    }

    private func celebrateTaskTransitions(from previous: [TaskItem], to current: [TaskItem]) {
        let previousLifecycle = Dictionary(uniqueKeysWithValues: previous.map {
            ($0.taskId, $0.taskContract?.lifecycleState ?? $0.state)
        })
        let completed = current.contains { item in
            let lifecycle = item.taskContract?.lifecycleState ?? item.state
            return lifecycle == "accepted" && previousLifecycle[item.taskId] != "accepted"
        }
        let closed = !previous.isEmpty && current.isEmpty
        if completed || closed {
            trigger(.jumping, for: .seconds(1.4))
        }
    }

    private func trigger(_ state: PetAnimationState, for duration: Duration) {
        motionResetTask?.cancel()
        interactionState = state
        motionResetTask = Task { [weak self] in
            try? await Task.sleep(for: duration)
            guard !Task.isCancelled, let self else { return }
            interactionState = nil
        }
    }

    private func read<T: Decodable>(_ endpoint: String) async throws -> T {
        guard let url = URL(string: "http://127.0.0.1:9466/api/\(endpoint)") else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 3
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

private struct PetSprite: View {
    let atlas: PetAtlas?
    let state: PetAnimationState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let animationColumns = atlas?.animationColumns(for: state) ?? Array(0..<state.frameLimit)
        Group {
            if reduceMotion || state == .idle {
                frame(column: animationColumns.first ?? 0)
            } else {
                TimelineView(.animation(minimumInterval: 0.16, paused: false)) { context in
                    let index = Int(context.date.timeIntervalSinceReferenceDate / 0.16) % animationColumns.count
                    frame(column: animationColumns[index])
                }
            }
        }
    }

    @ViewBuilder private func frame(column: Int) -> some View {
        if let image = atlas?.frame(row: state.row, column: column) {
            Image(decorative: image, scale: 1)
                .resizable()
                .interpolation(.none)
                .scaledToFit()
        } else {
            FoursdayMark()
        }
    }
}

private struct FoursdayMark: View {
    var body: some View {
        Grid(horizontalSpacing: 7, verticalSpacing: 7) {
            GridRow { block; block }
            GridRow { block; Image(systemName: "arrow.right").font(.title2.bold()).foregroundStyle(Color(hex: 0x1f765d)) }
        }
        .padding(16)
        .background(.white.opacity(0.94), in: RoundedRectangle(cornerRadius: 24))
    }
    private var block: some View {
        RoundedRectangle(cornerRadius: 7).fill(Color(hex: 0x1f765d)).frame(width: 24, height: 24)
    }
}

private struct TaskCard: View {
    let item: TaskItem

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(item.taskContract?.title ?? item.projectId ?? "等待任务合同")
                    .font(.headline)
                    .lineLimit(2)
                Spacer()
                Text(lifecycleLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            Text(item.taskContract?.goal ?? "Codex 尚未投影任务目标")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(3)
            if let criteria = item.taskContract?.acceptanceCriteria, !criteria.isEmpty {
                ForEach(criteria.prefix(3), id: \.self) { criterion in
                    Label(criterion, systemImage: "checkmark.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 14)
    }

    private var lifecycleLabel: String {
        switch item.taskContract?.lifecycleState ?? item.state {
        case "intake": "接单"
        case "planning": "规划"
        case "working", "active": "执行"
        case "verifying": "验证"
        case "waiting_acceptance": "待验收"
        case "rework_requested": "返工"
        case "escalated": "需协助"
        case "failed": "失败"
        case "accepted": "已验收"
        case "paused": "暂停"
        case "taken_over": "已接管"
        default: "处理中"
        }
    }
}

private struct PetRootView: View {
    @Bindable var model: PetModel

    var body: some View {
        HStack(alignment: .bottom, spacing: 14) {
            if model.expanded {
                taskDrawer
                    .transition(.move(edge: .leading).combined(with: .opacity))
            }

            PetSprite(atlas: model.atlas, state: model.animationState)
                    .frame(width: 112, height: 122)
                    .overlay(alignment: .topTrailing) {
                        if model.attentionCount > 0 {
                            Text(model.attentionCount > 99 ? "99+" : "\(model.attentionCount)")
                                .font(.caption2.bold())
                                .foregroundStyle(.white)
                                .padding(.horizontal, 6)
                                .frame(minHeight: 22)
                                .background(.red, in: Capsule())
                        }
                    }
            .contentShape(Rectangle())
            .onHover { model.setHovering($0) }
            .onTapGesture { model.petTapped() }
            .gesture(
                DragGesture(minimumDistance: 4, coordinateSpace: .global)
                    .onChanged { model.dragChanged($0.translation) }
                    .onEnded { _ in model.dragEnded() }
            )
            .help("查看 Foursday 任务")
            .contextMenu { Button("退出 Foursday 桌宠") { NSApplication.shared.terminate(nil) } }
        }
        .padding(10)
        .animation(.snappy(duration: 0.24), value: model.expanded)
    }

    private var taskDrawer: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("现在由我负责")
                        .font(.title2.bold())
                    Text(statusLine)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button { model.expanded = false } label: { Image(systemName: "xmark") }
                    .buttonStyle(.plain)
            }
            .padding(.bottom, 12)
            Divider()
            if model.tasks.isEmpty {
                ContentUnavailableView("暂无任务", systemImage: "checkmark.circle", description: Text("新的可执行任务会出现在这里。"))
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(model.tasks) { item in
                            TaskCard(item: item)
                            Divider()
                        }
                    }
                }
            }
        }
        .padding(20)
        .frame(width: 310, height: 500)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24))
        .overlay(RoundedRectangle(cornerRadius: 24).stroke(.white.opacity(0.45)))
    }

    private var statusLine: String {
        if let error = model.lastError { return error }
        guard let status = model.status else { return "正在读取任务状态" }
        let runtimeLabel = if status.gateway.sendBlocked == true || status.gateway.modeConsistent == false {
            "运行异常"
        } else if status.gateway.mode != "active" || status.gateway.running != true {
            "未运行"
        } else if status.gateway.checkpointState == "healthy" {
            "检查正常"
        } else {
            status.gateway.checkpointState
        }
        return "\(status.gateway.mode.uppercased()) · \(status.gateway.sendEnabled ? "发送开启" : "发送关闭") · \(runtimeLabel)"
    }
}

private extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8) & 0xff) / 255,
            blue: Double(hex & 0xff) / 255
        )
    }
}

@MainActor
private final class AppDelegate: NSObject, NSApplicationDelegate {
    private let model = PetModel()
    private var panel: NSPanel?
    private var dragOrigin: NSPoint?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let panel = NSPanel(
            contentRect: .zero,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isMovableByWindowBackground = false
        panel.hasShadow = false
        panel.contentView = NSHostingView(rootView: PetRootView(model: model))
        self.panel = panel
        model.onExpansionChanged = { [weak self] expanded in self?.resize(expanded: expanded) }
        model.onDragChanged = { [weak self] translation in self?.movePanel(by: translation) }
        model.onDragEnded = { [weak self] in self?.dragOrigin = nil }
        resize(expanded: false)
        panel.orderFrontRegardless()
        model.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        model.stop()
    }

    private func resize(expanded: Bool) {
        guard let panel, let screen = NSScreen.main else { return }
        let size = expanded ? NSSize(width: 456, height: 530) : NSSize(width: 132, height: 148)
        let visible = screen.visibleFrame
        let current = panel.frame
        let anchorMaxX = current.width > 0 ? current.maxX : visible.maxX - 18
        let anchorMinY = current.height > 0 ? current.minY : visible.minY + 18
        panel.setFrame(NSRect(
            x: min(max(visible.minX, anchorMaxX - size.width), visible.maxX - size.width),
            y: min(max(visible.minY, anchorMinY), visible.maxY - size.height),
            width: size.width,
            height: size.height
        ), display: true, animate: true)
    }

    private func movePanel(by translation: CGSize) {
        guard let panel else { return }
        let screen = panel.screen ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { return }
        if dragOrigin == nil { dragOrigin = panel.frame.origin }
        guard let origin = dragOrigin else { return }
        let next = NSPoint(
            x: min(max(visible.minX, origin.x + translation.width), visible.maxX - panel.frame.width),
            y: min(max(visible.minY, origin.y - translation.height), visible.maxY - panel.frame.height)
        )
        panel.setFrameOrigin(next)
    }
}

MainActor.assumeIsolated {
    let application = NSApplication.shared
    let applicationDelegate = AppDelegate()
    application.setActivationPolicy(.accessory)
    application.delegate = applicationDelegate
    withExtendedLifetime(applicationDelegate) {
        application.run()
    }
}
