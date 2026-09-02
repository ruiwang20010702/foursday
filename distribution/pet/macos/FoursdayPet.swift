import AppKit
import Observation
import SwiftUI

private struct StatusEnvelope: Decodable {
    struct Experience: Decodable {
        struct Responsibility: Decodable {
            let needsYou: Int
            let aiOwned: Int
            let recentlyCompleted: Int
            let owner: String
        }
        struct Recommendation: Decodable {
            let code: String
            let label: String
        }
        let state: String
        let title: String
        let detail: String
        let responsibility: Responsibility
        let recommendation: Recommendation
    }
    struct Gateway: Decodable {
        let installed: Bool?
        let mode: String
        let sendEnabled: Bool
        let checkpointState: String
        let checkpointBusy: Bool?
        let checkpointGeneration: Int?
        let checkpointOperation: String?
        let running: Bool?
        let sendBlocked: Bool?
        let modeConsistent: Bool?
        let eventWakeEnabled: Bool?
        let eventWakeReady: Bool?
        let eventWakeDegraded: Bool?
        let reactionWakeReadyCount: Int?
        let reactionWakeErrorCount: Int?
        let reactionWakeDegraded: Bool?
        let reactionWakeLastErrorCode: String?
        let manualReplyProbeReady: Bool?
        let manualReplyProbeDegraded: Bool?
        let manualReplyProbeErrorCode: String?
        let enterpriseIdentityRetryPending: Int?
        let enterpriseIdentityRejectionCount: Int?
        let enterpriseIdentityLastErrorCode: String?
        let lastWakeSource: String?
        let lastDetectionLatencyMs: Double?
    }
    struct Control: Decodable {
        let revision: Int
        let state: String
    }
    struct Release: Decodable {
        let version: String?
        let commit: String?
    }
    let ready: Bool
    let gateway: Gateway
    let control: Control
    let release: Release?
    let experience: Experience?
}

private struct TasksEnvelope: Decodable {
    let revision: Int
    let taskLedgerRevision: Int?
    let items: [TaskItem]
}

private struct SchedulesEnvelope: Decodable {
    struct Item: Decodable, Identifiable {
        let id: String
        let name: String
        let enabled: Bool
        let state: String
        let schedule: String
        let nextRunAt: String?
        let lastRunAt: String?
        let lastStatus: String?
        let monitor: Bool
        let continuity: Bool
        let delivery: String
    }
    let items: [Item]
}

private struct MemoryEnvelope: Decodable {
    struct FixedBindings: Decodable {
        let projectCount: Int
        let pageCount: Int
    }
    struct Discovery: Decodable {
        let enabled: Bool
        let state: String
        let projectCount: Int?
        let truncated: Bool
    }
    let sourceId: String
    let readEnabled: Bool
    let writeEnabled: Bool
    let fixedBindings: FixedBindings
    let discovery: Discovery
}

private struct EvidenceEnvelope: Decodable {
    let count: Int
    let byType: [String: Int]
    let lastEventAt: String?
}

private struct TaskItem: Decodable, Identifiable {
    struct UserState: Decodable {
        let state: String
        let title: String
        let detail: String
        let owner: String
        let waitTier: String
    }
    struct Contract: Decodable {
        let title: String
        let goal: String
        let lifecycleState: String
        let deliverables: [String]?
        let acceptanceCriteria: [String]
        let evidenceCounts: [String: Int]
    }
    struct Activity: Decodable, Identifiable {
        let eventId: String
        let kind: String
        let summary: String
        let detail: String
        let occurredAt: String
        var id: String { eventId }
    }
    struct ThreadView: Decodable {
        let available: Bool
        let reason: String
    }
    struct Requester: Decodable {
        let displayName: String
        let channel: String
    }
    struct Executor: Decodable {
        let displayName: String
        let runtime: String
        let threadBound: Bool
        let threadSpace: String
    }
    struct Progress: Decodable {
        let stage: String
        let activityCount: Int
        let hasPlan: Bool
        let lastActivityAt: String?
    }
    struct Execution: Decodable {
        let executionId: String
        let mode: String
        let state: String
        let decisionSource: String
        let planSummary: String
        let activityCount: Int
        let attemptCount: Int
        let startedAt: String?
        let updatedAt: String?
        let lastErrorCode: String?
    }
    let taskId: String
    let projectId: String?
    let projectName: String?
    let requester: Requester?
    let executor: Executor?
    let progress: Progress?
    let execution: Execution?
    let assignmentState: String?
    let projectGroupId: String?
    let projectGroupName: String?
    let summaryTitle: String?
    let state: String
    let codexThreadId: String?
    let lastInboundAt: String?
    let updatedAt: String?
    let pendingIntervention: PendingIntervention?
    let taskContract: Contract?
    let worksiteGroup: String?
    let activityTrail: [Activity]?
    let missingEvidence: [String]?
    let threadView: ThreadView?
    let userState: UserState?
    var id: String { taskId }
}

private struct ProjectTaskGroup: Identifiable {
    let id: String
    let name: String
    let tasks: [TaskItem]
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

private enum WorksiteGroup: String, CaseIterable, Identifiable {
    case needsMe = "needs_me"
    case working
    case recent

    var id: String { rawValue }
    var label: String {
        switch self {
        case .needsMe: "需要我"
        case .working: "AI负责"
        case .recent: "最近完成"
        }
    }
    var icon: String {
        switch self {
        case .needsMe: "person.crop.circle.badge.exclamationmark"
        case .working: "bolt.circle"
        case .recent: "clock.arrow.circlepath"
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
    var schedules: SchedulesEnvelope?
    var memory: MemoryEnvelope?
    var evidence: EvidenceEnvelope?
    var tasksRevision = 0
    var selectedGroup = WorksiteGroup.needsMe
    var selectedTaskId: String?
    var collapsedProjectIds: Set<String> = []
    var showingDiagnostics = false
    var controlInFlight = false
    var controlMessage: String?
    var expanded = false {
        didSet {
            if !expanded { showingDiagnostics = false }
            onExpansionChanged?(expanded)
        }
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

    var userStatusTitle: String {
        if lastError != nil { return "状态暂不可用" }
        guard let status else { return "正在读取状态" }
        if let experience = status.experience { return experience.title }
        if status.control.state == "paused" { return "已暂停" }
        if status.gateway.sendBlocked == true || status.gateway.modeConsistent == false {
            return "自动回复已暂停"
        }
        if status.gateway.running != true { return "Foursday未运行" }
        if ["failed", "error", "blocked", "unknown_send"].contains(status.gateway.checkpointState) {
            return "消息同步异常"
        }
        if status.gateway.checkpointBusy == true { return "正在同步新消息" }
        if status.gateway.mode == "shadow" { return "试用中" }
        if status.ready && status.gateway.sendEnabled { return "已上岗" }
        return "需要检查"
    }

    var userStatusDetail: String {
        if lastError != nil { return "正在重新连接Foursday工作服务" }
        guard let status else { return "正在连接Foursday工作服务" }
        if let experience = status.experience { return experience.detail }
        switch userStatusTitle {
        case "试用中": return "当前不会自动回复钉钉消息"
        case "已上岗": return "钉钉连接与任务处理正常"
        case "正在同步新消息": return "Foursday正在补齐消息，任务可以继续"
        case "已暂停": return "现有任务和自动回复已暂停"
        case "自动回复已暂停": return "系统无法确认一次发送结果，已停止后续回复"
        case "消息同步异常": return "新消息可能暂时无法进入Foursday"
        case "Foursday未运行": return "当前不会接收或处理新任务"
        default: return status.ready ? "工作服务可用" : "部分工作能力暂不可用"
        }
    }

    var recommendedAction: String {
        if lastError != nil { return "在Codex中检查Foursday状态" }
        guard let status else { return "等待状态加载完成" }
        if let experience = status.experience { return experience.recommendation.label }
        if status.gateway.sendBlocked == true || status.gateway.modeConsistent == false ||
            status.gateway.running != true || !status.ready {
            return "在Codex中检查Foursday状态"
        }
        if memory?.discovery.state == "unavailable" {
            return "无需操作，历史背景会自动重试"
        }
        if schedules == nil || memory == nil || evidence == nil {
            return "在Codex中检查Foursday状态"
        }
        return "无需操作"
    }

    var selectedTask: TaskItem? {
        guard let selectedTaskId else { return nil }
        return tasks.first(where: { $0.taskId == selectedTaskId })
    }

    func tasks(in group: WorksiteGroup) -> [TaskItem] {
        tasks.filter { groupForTask($0) == group }
    }

    func projectGroups() -> [ProjectTaskGroup] {
        let grouped = Dictionary(grouping: tasks) { item in
            item.projectGroupId ?? item.projectId ?? "__unassigned"
        }
        return grouped.map { key, items in
            ProjectTaskGroup(
                id: key,
                name: items.first?.projectGroupName ?? items.first?.projectName ?? "待归属项目",
                tasks: items.sorted {
                    String($0.lastInboundAt ?? $0.updatedAt ?? "") >
                        String($1.lastInboundAt ?? $1.updatedAt ?? "")
                }
            )
        }.sorted { left, right in
            if left.id == "__legacy_unassigned" { return false }
            if right.id == "__legacy_unassigned" { return true }
            let leftDate = left.tasks.first?.lastInboundAt ?? left.tasks.first?.updatedAt ?? ""
            let rightDate = right.tasks.first?.lastInboundAt ?? right.tasks.first?.updatedAt ?? ""
            if leftDate != rightDate { return leftDate > rightDate }
            return left.name.localizedStandardCompare(right.name) == .orderedAscending
        }
    }

    func toggleProject(_ projectId: String) {
        if collapsedProjectIds.contains(projectId) {
            collapsedProjectIds.remove(projectId)
        } else {
            collapsedProjectIds.insert(projectId)
        }
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

    func select(_ item: TaskItem) {
        selectedTaskId = item.taskId
        selectedGroup = groupForTask(item)
        controlMessage = nil
    }

    func performControl(_ command: String, task: TaskItem) {
        guard !controlInFlight else { return }
        controlInFlight = true
        controlMessage = nil
        Task { [weak self] in
            guard let self else { return }
            do {
                guard let executable = locateFoursday() else { throw PetControlError.cliUnavailable }
                try await runControlProcess(
                    executable,
                    arguments: [
                        "control", command,
                        "--revision", String(tasksRevision),
                        "--task", task.taskId,
                    ]
                )
                await refresh()
                controlMessage = "操作已应用"
            } catch {
                await refresh()
                controlMessage = "状态已变化或操作失败，请确认后重试"
            }
            controlInFlight = false
        }
    }

    func openCodex(_ task: TaskItem) {
        guard task.threadView?.available == true,
              let threadId = task.codexThreadId,
              threadId.range(of: "^[A-Za-z0-9._:-]{1,500}$", options: .regularExpression) != nil,
              let url = URL(string: "codex://threads/\(threadId)")
        else { return }
        NSWorkspace.shared.open(url)
    }

    func copyThreadReference(_ task: TaskItem) {
        guard let threadId = task.codexThreadId,
              threadId.range(of: "^[A-Za-z0-9._:-]{1,500}$", options: .regularExpression) != nil
        else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(threadId, forType: .string)
        controlMessage = "已复制 Foursday 独立会话编号"
    }

    private func ensureDashboard() async {
        if await dashboardAvailable() { return }
        guard let executable = locateFoursday(), let node = locateNode() else {
            lastError = "找不到 foursday 命令"
            return
        }
        let process = Process()
        process.executableURL = node
        process.arguments = [executable.path, "dashboard", "--port", "9466"]
        process.environment = foursdayProcessEnvironment()
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
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
        return candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) })
            .map { URL(fileURLWithPath: $0).resolvingSymlinksInPath() }
    }

    private func locateNode() -> URL? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [
            "/opt/homebrew/opt/node@24/bin/node",
            "/opt/homebrew/opt/node@22/bin/node",
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            home + "/.local/bin/node",
        ]
        return candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) })
            .map(URL.init(fileURLWithPath:))
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
            async let nextSchedules: SchedulesEnvelope? = try? read("schedules")
            async let nextMemory: MemoryEnvelope? = try? read("memory")
            async let nextEvidence: EvidenceEnvelope? = try? read("evidence")
            let refreshedStatus = try await nextStatus
            let refreshedEnvelope = try await nextTasks
            let refreshedTasks = refreshedEnvelope.items
            if hasLoadedTasks {
                celebrateTaskTransitions(from: tasks, to: refreshedTasks)
            }
            status = refreshedStatus
            tasks = refreshedTasks
            schedules = await nextSchedules
            memory = await nextMemory
            evidence = await nextEvidence
            tasksRevision = refreshedEnvelope.revision
            if selectedTaskId == nil || !tasks.contains(where: { $0.taskId == selectedTaskId }) {
                let preferred = tasks.first(where: { groupForTask($0) == .needsMe })
                    ?? tasks.first(where: { groupForTask($0) == .working })
                    ?? tasks.first
                selectedTaskId = preferred?.taskId
                if let preferred { selectedGroup = groupForTask(preferred) }
            }
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

    private func groupForTask(_ item: TaskItem) -> WorksiteGroup {
        if let value = item.worksiteGroup, let group = WorksiteGroup(rawValue: value) { return group }
        if item.state == "taken_over" { return .recent }
        if item.pendingIntervention != nil || [
            "waiting_acceptance", "rework_requested", "escalated", "failed",
        ].contains(item.taskContract?.lifecycleState) { return .needsMe }
        return item.state == "active" ? .working : .recent
    }

    private func runControlProcess(_ executable: URL, arguments: [String]) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            guard let node = locateNode() else {
                continuation.resume(throwing: PetControlError.cliUnavailable)
                return
            }
            let process = Process()
            process.executableURL = node
            process.arguments = [executable.path] + arguments
            process.environment = foursdayProcessEnvironment()
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            process.terminationHandler = { process in
                if process.terminationStatus == 0 {
                    continuation.resume()
                } else {
                    continuation.resume(throwing: PetControlError.commandFailed)
                }
            }
            do { try process.run() }
            catch { continuation.resume(throwing: error) }
        }
    }

    private func foursdayProcessEnvironment() -> [String: String] {
        let current = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var environment = [
            "HOME": home,
            "PATH": [
                "/opt/homebrew/opt/node@24/bin",
                "/opt/homebrew/opt/node@22/bin",
                "/opt/homebrew/bin",
                "/usr/local/bin",
                home + "/.local/bin",
                "/usr/bin",
                "/bin",
                "/usr/sbin",
                "/sbin",
            ].joined(separator: ":"),
            "LANG": current["LANG"] ?? "C.UTF-8",
        ]
        if let temporary = current["TMPDIR"], temporary.hasPrefix("/") {
            environment["TMPDIR"] = temporary
        }
        return environment
    }
}

private enum PetControlError: Error {
    case cliUnavailable
    case commandFailed
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

private extension TaskItem {
    var displayTitle: String {
        if let title = taskContract?.title, !title.isEmpty { return title }
        if let title = summaryTitle, !title.isEmpty { return title }
        let time = compactTaskTime(lastInboundAt ?? updatedAt)
        if assignmentState == "routing" { return "正在识别 · \(time)" }
        if assignmentState == "legacy_unassigned" { return "未归档记录 · \(time)" }
        return "历史任务 · \(time)"
    }
    var secondaryLabel: String {
        worksiteGroupLabel == lifecycleLabel
            ? worksiteGroupLabel
            : "\(worksiteGroupLabel) · \(lifecycleLabel)"
    }
    var worksiteGroupLabel: String {
        switch worksiteGroup {
        case "needs_me": "需要我"
        case "recent": "最近处理"
        default: "AI负责"
        }
    }
    var lifecycleLabel: String {
        if assignmentState == "routing" { return "识别中" }
        if assignmentState == "legacy_unassigned" { return "未归档" }
        if execution?.mode == "background" {
            return switch execution?.state {
            case "ack_pending": "准备接单"
            case "acknowledged": "已经接单"
            case "queued": "后台排队"
            case "running": "后台执行"
            case "blocked": "等待协助"
            case "completed": "执行完成"
            case "failed": "后台失败"
            case "cancelled": "已取消"
            default: "后台任务"
            }
        }
        if taskContract == nil {
            switch state {
            case "active": return "AI负责"
            case "paused": return "已暂停"
            case "taken_over": return "已接管"
            default: return "历史记录"
            }
        }
        return switch taskContract?.lifecycleState ?? state {
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
    var requesterChannelLabel: String {
        switch requester?.channel {
        case "dingtalk_group": "钉钉群聊"
        case "dingtalk_direct": "钉钉私聊"
        default: "来源未记录"
        }
    }
    var progressEmptyText: String {
        if execution?.mode == "background" {
            return switch execution?.state {
            case "ack_pending": "等待发送一次接单确认"
            case "acknowledged": "已发送接单确认，准备进入后台"
            case "queued": "后台任务已持久化，等待同一 Codex Thread 续跑"
            case "running": "同一 Codex Thread 正在后台继续执行"
            case "blocked": "后台任务需要补充信息或负责人处理"
            case "completed": "后台任务已完成并取得最终回执"
            case "failed": "后台重试已耗尽，等待负责人处理"
            case "cancelled": "旧任务代次已失效，不再继续发送"
            default: "后台任务状态待更新"
            }
        }
        return switch progress?.stage {
        case "thread_bound": "Codex 会话已建立，尚无可展示的执行活动"
        case "received": "任务已收到，正在建立执行上下文"
        case "paused": "任务已暂停，等待恢复"
        case "taken_over": "任务已由负责人接管"
        case "waiting_acceptance": "任务计划已生成，正在等待验收"
        case "failed": "最近一次执行已失败，等待处理"
        case _ where progress?.hasPlan == true: "任务计划已生成，等待第一条执行活动"
        default: "尚未采集到可展示的执行活动"
        }
    }
}

private func compactTaskTime(_ value: String?) -> String {
    guard let value else { return "时间未知" }
    let precise = ISO8601DateFormatter()
    precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date = precise.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    guard let date else { return "时间未知" }
    let output = DateFormatter()
    output.locale = Locale(identifier: "zh_CN")
    output.dateFormat = "M月d日 HH:mm"
    return output.string(from: date)
}

private struct WorksiteTaskRow: View {
    let item: TaskItem
    let selected: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(item.displayTitle)
                .font(.subheadline.weight(.semibold))
                .lineLimit(2)
            Text(item.secondaryLabel).lineLimit(1)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(selected ? Color(hex: 0xdcebe5) : .clear, in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct WorksiteProjectList: View {
    @Bindable var model: PetModel

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 8) {
            ForEach(model.projectGroups()) { project in
                VStack(alignment: .leading, spacing: 2) {
                    Button { model.toggleProject(project.id) } label: {
                        HStack(spacing: 6) {
                            Image(systemName: model.collapsedProjectIds.contains(project.id)
                                ? "chevron.right" : "chevron.down")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(.secondary)
                            Image(systemName: project.id.contains("legacy_unassigned")
                                ? "archivebox"
                                : project.id.contains("routing") ? "magnifyingglass" : "folder")
                                .foregroundStyle(.secondary)
                            Text(project.name)
                                .font(.caption.weight(.semibold))
                                .lineLimit(1)
                            Spacer()
                            Text("\(project.tasks.count)")
                                .font(.caption2.monospacedDigit())
                                .foregroundStyle(.secondary)
                        }
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 8)
                    .padding(.top, 4)

                    if !model.collapsedProjectIds.contains(project.id) {
                        ForEach(project.tasks) { item in
                            Button { model.select(item) } label: {
                                WorksiteTaskRow(item: item, selected: model.selectedTaskId == item.taskId)
                            }
                            .buttonStyle(.plain)
                            .padding(.leading, 12)
                        }
                    }
                }
            }
        }
    }
}

private struct ActivityRow: View {
    let activity: TaskItem.Activity

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .frame(width: 18)
                .foregroundStyle(Color(hex: 0x1f765d))
            VStack(alignment: .leading, spacing: 2) {
                Text(activity.summary).font(.caption.weight(.semibold))
                if !activity.detail.isEmpty {
                    Text(activity.detail).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            Spacer(minLength: 0)
        }
    }

    private var icon: String {
        switch activity.kind {
        case "analyze": "brain.head.profile"
        case "read": "doc.text"
        case "search": "magnifyingglass"
        case "edit": "square.and.pencil"
        case "test": "checkmark.seal"
        case "verify": "checkmark.circle"
        case "complete": "party.popper"
        case "failed": "exclamationmark.triangle"
        default: "wrench.and.screwdriver"
        }
    }
}

private struct WorksiteDetail: View {
    @Bindable var model: PetModel
    let item: TaskItem
    @State private var confirmTakeover = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(item.displayTitle).font(.title2.bold()).lineLimit(2)
                        Spacer()
                        Text(item.userState?.title ?? item.lifecycleLabel)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    Text(item.taskContract?.goal ?? fallbackGoal)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    if let userState = item.userState {
                        Label(userState.detail, systemImage: userState.owner == "you" ? "person.crop.circle.badge.exclamationmark" : "sparkles")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(userState.owner == "you" ? .orange : Color(hex: 0x1f765d))
                    }
                }

                section("责任关系") {
                    VStack(alignment: .leading, spacing: 8) {
                        Label(
                            item.requester.map { "请求人：\($0.displayName)" }
                                ?? "请求人：历史记录未保留联系人",
                            systemImage: "person.crop.circle"
                        )
                        Text(item.requesterChannelLabel)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .padding(.leading, 28)
                        Label(
                            "执行者：\(item.executor?.displayName ?? "Foursday") · \(item.executor?.runtime ?? "Codex")",
                            systemImage: "sparkles"
                        )
                        Text(item.executor?.threadSpace == "desktop"
                            ? "执行会话可在主 Codex 中查看"
                            : "执行会话位于 Foursday 专属 Codex 空间")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .padding(.leading, 28)
                    }
                    .font(.caption)
                }

                if let execution = item.execution {
                    section("工作方式") {
                        Label(
                            execution.mode == "background" ? "后台继续处理" : "当前会话内处理",
                            systemImage: execution.mode == "background" ? "clock.arrow.2.circlepath" : "bolt"
                        )
                        .font(.caption.weight(.semibold))
                        Text(execution.planSummary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        DisclosureGroup("技术详情") {
                            Text("mode=\(execution.mode) · state=\(execution.state) · attempts=\(execution.attemptCount)")
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                        }
                        .font(.caption2)
                    }
                }

                section("当前进度") {
                    if let activities = item.activityTrail, !activities.isEmpty {
                        ForEach(activities.suffix(8)) { activity in ActivityRow(activity: activity) }
                    } else {
                        Label(item.progressEmptyText, systemImage: "clock")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if let updatedAt = item.progress?.lastActivityAt ?? item.updatedAt {
                        Text("最近更新：\(compactTaskTime(updatedAt))")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }

                if let missing = item.missingEvidence, !missing.isEmpty {
                    section("仍缺少") {
                        ForEach(missing.prefix(4), id: \.self) { value in
                            Label(value, systemImage: "circle.dashed")
                                .font(.caption)
                                .foregroundStyle(.orange)
                        }
                    }
                }

                if let criteria = item.taskContract?.acceptanceCriteria, !criteria.isEmpty {
                    section("验收条件") {
                        ForEach(criteria.prefix(5), id: \.self) { value in
                            Label(value, systemImage: "checkmark.circle")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                evidenceSummary
                actionBar
                if let message = model.controlMessage {
                    Text(message).font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(.trailing, 4)
        }
        .confirmationDialog("接管整个任务？", isPresented: $confirmTakeover) {
            Button("接管任务", role: .destructive) {
                model.performControl("takeover-task", task: item)
            }
        } message: {
            Text("这会停止当前任务和后续子工作；以后仍可恢复。")
        }
    }

    private var fallbackGoal: String {
        if item.assignmentState == "routing" {
            return "Foursday 正在结合会话、gbrain 与项目注册表识别项目，无需请求人创建名称或文件夹。"
        }
        if item.assignmentState == "legacy_unassigned" {
            return "这是一条缺少项目、任务合同和 Codex Thread 的旧控制记录，已移入未归档历史且不再计入 AI 负责。"
        }
        if item.codexThreadId != nil {
            return "Codex 会话已经建立，但这条历史任务尚未生成目标、交付物与验收计划。"
        }
        return "这是一条历史任务记录，尚未形成可追溯的执行上下文。"
    }

    @ViewBuilder private func section<Content: View>(
        _ title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(title).font(.caption.weight(.bold)).foregroundStyle(.secondary)
            content()
        }
    }

    @ViewBuilder private var evidenceSummary: some View {
        if let counts = item.taskContract?.evidenceCounts {
            HStack(spacing: 14) {
                Label("\(counts["verified"] ?? 0) 已验证", systemImage: "checkmark.seal.fill")
                Label("\(counts["observed"] ?? 0) 已观察", systemImage: "eye")
                Label("\(counts["missing"] ?? 0) 缺失", systemImage: "circle.dashed")
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        } else {
            Label("任务计划尚未生成，验收证据暂未开始统计", systemImage: "info.circle")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private var actionBar: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                if item.state == "active" {
                    Button("暂停") { model.performControl("pause-task", task: item) }
                    Button("我来回复") { model.performControl("communication-takeover", task: item) }
                    Button("接管任务") { confirmTakeover = true }
                } else {
                    Button("恢复") { model.performControl("resume-task", task: item) }
                }
            }
            .buttonStyle(.bordered)
            .disabled(model.controlInFlight)

            if item.threadView?.available == true {
                Button { model.openCodex(item) } label: {
                    Label("在 Codex 查看", systemImage: "arrow.up.forward.app")
                }
                .buttonStyle(.borderedProminent)
                .tint(Color(hex: 0x1f765d))
                .help("打开对应 Codex Thread")
            } else if item.codexThreadId != nil {
                Button { model.copyThreadReference(item) } label: {
                    Label("复制独立会话编号", systemImage: "doc.on.doc")
                }
                .buttonStyle(.bordered)
                Text("该会话使用 Foursday 专属 Codex 空间，不会出现在主 Codex 侧边栏。")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else {
                Label("尚未建立 Codex 会话", systemImage: "clock")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct DiagnosticStatusRow: View {
    let title: String
    let value: String
    let icon: String
    let healthy: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .frame(width: 20)
                .foregroundStyle(healthy ? Color(hex: 0x1f765d) : .orange)
            Text(title).font(.subheadline.weight(.semibold))
            Spacer(minLength: 12)
            Text(value)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.trailing)
        }
        .padding(.vertical, 3)
    }
}

private struct SystemDiagnosticsView: View {
    @Bindable var model: PetModel
    @State private var technicalDetailsExpanded = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                GroupBox {
                    VStack(alignment: .leading, spacing: 6) {
                        Label(model.userStatusTitle, systemImage: summaryIcon)
                            .font(.title3.bold())
                            .foregroundStyle(summaryColor)
                        Text(model.userStatusDetail)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        Divider().padding(.vertical, 3)
                        Text("建议：\(model.recommendedAction)")
                            .font(.caption.weight(.semibold))
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                GroupBox("连接与工作环境") {
                    VStack(spacing: 8) {
                        DiagnosticStatusRow(
                            title: "钉钉连接",
                            value: dingtalkStatus,
                            icon: "message.badge.waveform",
                            healthy: dingtalkHealthy
                        )
                        Divider()
                        DiagnosticStatusRow(
                            title: "Codex工作环境",
                            value: model.status?.gateway.installed == true ? "已配置" : "未配置",
                            icon: "sparkles",
                            healthy: model.status?.gateway.installed == true
                        )
                        Divider()
                        DiagnosticStatusRow(
                            title: "消息同步",
                            value: checkpointStatus,
                            icon: "arrow.triangle.2.circlepath",
                            healthy: checkpointHealthy
                        )
                    }
                }

                GroupBox("知识与工作记录") {
                    VStack(spacing: 8) {
                        DiagnosticStatusRow(
                            title: "个人记忆",
                            value: memoryStatus,
                            icon: "brain.head.profile",
                            healthy: memoryHealthy
                        )
                        Divider()
                        DiagnosticStatusRow(
                            title: "运行证据",
                            value: evidenceStatus,
                            icon: "checkmark.seal",
                            healthy: model.evidence != nil
                        )
                        Divider()
                        DiagnosticStatusRow(
                            title: "主动工作",
                            value: scheduleStatus,
                            icon: "calendar.badge.clock",
                            healthy: model.schedules != nil
                        )
                        Divider()
                        DiagnosticStatusRow(
                            title: "当前版本",
                            value: releaseStatus,
                            icon: "shippingbox",
                            healthy: model.status?.release?.commit != nil
                        )
                    }
                }

                DisclosureGroup("技术详情", isExpanded: $technicalDetailsExpanded) {
                    VStack(spacing: 7) {
                        technicalRow("运行模式", model.status?.gateway.mode.uppercased() ?? "—")
                        technicalRow("真实发送", model.status?.gateway.sendEnabled == true ? "开启" : "关闭")
                        technicalRow("Control", model.status?.control.state ?? "—")
                        technicalRow("Checkpoint", checkpointTechnicalStatus)
                        technicalRow("Event Wake", model.status?.gateway.eventWakeReady == true ? "ready" : "degraded")
                        technicalRow("Reaction", reactionTechnicalStatus)
                        technicalRow("人工回复探针", manualProbeTechnicalStatus)
                        technicalRow("企业身份重试", "\(model.status?.gateway.enterpriseIdentityRetryPending ?? 0)")
                        technicalRow("固定记忆", fixedMemoryTechnicalStatus)
                        technicalRow("可发现项目", discoveredMemoryTechnicalStatus)
                        technicalRow("证据类型", evidenceTechnicalStatus)
                        technicalRow("精确提交", model.status?.release?.commit ?? "—")
                        if let errorCode = primaryErrorCode {
                            technicalRow("错误码", errorCode)
                        }
                    }
                    .padding(.top, 10)
                }
                .font(.caption.weight(.semibold))

                Text("浏览器页面只在桌宠不可用或非macOS环境下作为只读应急入口；这里与它读取同一个Control服务。")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .padding(.trailing, 4)
        }
    }

    private var summaryIcon: String {
        switch model.userStatusTitle {
        case "已上岗": "checkmark.circle.fill"
        case "试用中": "testtube.2"
        case "正在同步新消息": "arrow.triangle.2.circlepath"
        case "已暂停": "pause.circle.fill"
        default: "exclamationmark.triangle.fill"
        }
    }

    private var summaryColor: Color {
        ["已上岗", "试用中", "正在同步新消息"].contains(model.userStatusTitle)
            ? Color(hex: 0x1f765d)
            : .orange
    }

    private var dingtalkHealthy: Bool {
        model.status?.gateway.eventWakeReady == true || checkpointHealthy
    }

    private var dingtalkStatus: String {
        if model.status?.gateway.eventWakeReady == true { return "连接正常" }
        if checkpointHealthy { return "备用同步正常" }
        return "需要检查"
    }

    private var checkpointHealthy: Bool {
        ["healthy", "busy_but_bounded"].contains(model.status?.gateway.checkpointState)
    }

    private var checkpointStatus: String {
        switch model.status?.gateway.checkpointState {
        case "healthy": "同步正常"
        case "busy_but_bounded": "正在同步新消息"
        case "stale": "消息同步已过期"
        case "failed": "消息同步失败"
        default: "暂不可用"
        }
    }

    private var memoryHealthy: Bool {
        guard let memory = model.memory else { return false }
        return !memory.readEnabled || ["ready", "disabled"].contains(memory.discovery.state)
    }

    private var memoryStatus: String {
        guard let memory = model.memory else { return "暂不可用" }
        if !memory.readEnabled { return "未开启" }
        if memory.discovery.state == "unavailable" { return "历史背景暂不可用" }
        let count = memory.discovery.projectCount.map(String.init) ?? "—"
        return "读取正常 · 可发现\(count)个项目"
    }

    private var evidenceStatus: String {
        guard let evidence = model.evidence else { return "暂不可用" }
        if let time = evidence.lastEventAt { return "\(evidence.count)条 · \(compactTaskTime(time))" }
        return "\(evidence.count)条运行证据"
    }

    private var scheduleStatus: String {
        guard let schedules = model.schedules else { return "暂不可用" }
        let enabled = schedules.items.filter(\.enabled).count
        return enabled == 0 ? "未启用" : "\(enabled)项已启用"
    }

    private var releaseStatus: String {
        let version = model.status?.release?.version ?? "版本未知"
        guard let commit = model.status?.release?.commit else { return version }
        return "\(version) · \(commit.prefix(7))"
    }

    private var checkpointTechnicalStatus: String {
        let gateway = model.status?.gateway
        let state = gateway?.checkpointState ?? "unknown"
        let generation = gateway?.checkpointGeneration ?? 0
        return "\(state) · generation \(generation)"
    }

    private var reactionTechnicalStatus: String {
        let ready = model.status?.gateway.reactionWakeReadyCount ?? 0
        let failed = model.status?.gateway.reactionWakeErrorCount ?? 0
        return "\(ready) ready / \(failed) failed"
    }

    private var manualProbeTechnicalStatus: String {
        if model.status?.gateway.manualReplyProbeReady == true { return "ready" }
        if model.status?.gateway.manualReplyProbeDegraded == true { return "degraded" }
        return "unknown"
    }

    private var fixedMemoryTechnicalStatus: String {
        guard let memory = model.memory else { return "—" }
        return "\(memory.fixedBindings.projectCount)个范围 / \(memory.fixedBindings.pageCount)页"
    }

    private var discoveredMemoryTechnicalStatus: String {
        guard let discovery = model.memory?.discovery else { return "—" }
        return discovery.projectCount.map { "\($0) · \(discovery.state)" } ?? discovery.state
    }

    private var evidenceTechnicalStatus: String {
        guard let evidence = model.evidence else { return "—" }
        return evidence.byType.sorted(by: { $0.key < $1.key })
            .map { "\($0.key):\($0.value)" }.joined(separator: " · ")
    }

    private var primaryErrorCode: String? {
        let gateway = model.status?.gateway
        return gateway?.manualReplyProbeErrorCode ?? gateway?.reactionWakeLastErrorCode ??
            gateway?.enterpriseIdentityLastErrorCode
    }

    @ViewBuilder private func technicalRow(_ title: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(title).foregroundStyle(.secondary)
            Spacer(minLength: 14)
            Text(value).font(.caption.monospaced()).multilineTextAlignment(.trailing)
        }
    }
}

private struct WorksiteView: View {
    @Bindable var model: PetModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Foursday 工作现场").font(.title2.bold())
                    Text(statusLine).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    model.showingDiagnostics.toggle()
                } label: {
                    Label(
                        model.showingDiagnostics ? "返回工作现场" : "设置与系统诊断",
                        systemImage: model.showingDiagnostics ? "arrow.left" : "gearshape"
                    )
                }
                .buttonStyle(.bordered)
                Button { model.expanded = false } label: { Image(systemName: "xmark") }
                    .buttonStyle(.plain)
            }
            Divider()
            if model.showingDiagnostics {
                SystemDiagnosticsView(model: model)
            } else {
                HStack(alignment: .top, spacing: 16) {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(WorksiteGroup.allCases) { group in
                            HStack {
                                Label(group.label, systemImage: group.icon)
                                    .font(.caption.weight(.semibold))
                                Spacer()
                                Text("\(model.tasks(in: group).count)")
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.horizontal, 8)
                        }
                        Divider().padding(.vertical, 4)
                        ScrollView {
                            WorksiteProjectList(model: model)
                        }
                    }
                    .frame(width: 188)

                    Divider()
                    if let task = model.selectedTask {
                        WorksiteDetail(model: model, item: task)
                    } else {
                        ContentUnavailableView(
                            "这个分区暂无任务",
                            systemImage: "checkmark.circle",
                            description: Text("Foursday 会在任务状态变化后自动更新。")
                        )
                    }
                }
            }
        }
        .padding(20)
        .frame(width: 620, height: 580)
        .background(
            Color(nsColor: .windowBackgroundColor).opacity(0.98),
            in: RoundedRectangle(cornerRadius: 24)
        )
    }

    private var statusLine: String {
        "\(model.userStatusTitle) · \(model.userStatusDetail)"
    }
}

private struct PetRootView: View {
    @Bindable var model: PetModel

    var body: some View {
        HStack(alignment: .bottom, spacing: 14) {
            if model.expanded {
                WorksiteView(model: model)
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
    private var dragPanelOrigin: NSPoint?
    private var dragMouseOrigin: NSPoint?

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
        model.onDragEnded = { [weak self] in self?.endDrag() }
        resize(expanded: false)
        panel.orderFrontRegardless()
        model.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        model.stop()
    }

    private func resize(expanded: Bool) {
        guard let panel, let screen = NSScreen.main else { return }
        let size = expanded ? NSSize(width: 764, height: 610) : NSSize(width: 132, height: 148)
        let visible = screen.visibleFrame
        let current = panel.frame
        let anchorMaxX = current.width > 0 ? current.maxX : visible.maxX - 18
        let anchorMinY = current.height > 0 ? current.minY : visible.minY + 18
        panel.setFrame(NSRect(
            x: min(max(visible.minX, anchorMaxX - size.width), visible.maxX - size.width),
            y: min(max(visible.minY, anchorMinY), visible.maxY - size.height),
            width: size.width,
            height: size.height
        ), display: false, animate: false)
    }

    private func movePanel(by translation: CGSize) {
        guard let panel else { return }
        let mouse = NSEvent.mouseLocation
        if dragPanelOrigin == nil || dragMouseOrigin == nil {
            dragPanelOrigin = panel.frame.origin
            dragMouseOrigin = NSPoint(
                x: mouse.x - translation.width,
                y: mouse.y + translation.height
            )
        }
        guard let panelOrigin = dragPanelOrigin, let mouseOrigin = dragMouseOrigin else { return }
        let screen = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) })
            ?? panel.screen
            ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { return }
        let next = NSPoint(
            x: min(max(visible.minX, panelOrigin.x + mouse.x - mouseOrigin.x), visible.maxX - panel.frame.width),
            y: min(max(visible.minY, panelOrigin.y + mouse.y - mouseOrigin.y), visible.maxY - panel.frame.height)
        )
        panel.setFrameOrigin(next)
    }

    private func endDrag() {
        dragPanelOrigin = nil
        dragMouseOrigin = nil
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
