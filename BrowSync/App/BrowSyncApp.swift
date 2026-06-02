// BrowSyncApp.swift
// BrowSync — App entry point

import SwiftUI
import AppKit
import Sparkle

@main
struct BrowSyncApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var appState = AppState()

    var body: some Scene {
        Window("BrowSync", id: "SettingsWindow") {
            ContentView()
                .environmentObject(appState)
                .frame(width: 750, height: 600)
                .onAppear {
                    appDelegate.appState = appState
                    appDelegate.settingsWindowDidAppear()
                }
        }
        .windowResizability(.contentSize)
        .windowStyle(.titleBar)
        .windowToolbarStyle(.unified)
        .commands {
            CommandGroup(replacing: .newItem) {}
        }

        // Menu Bar Extra (macOS 13+)
        MenuBarExtra("BrowSync", systemImage: "arrow.triangle.2.circlepath.circle.fill") {
            MenuBarView()
                .environmentObject(appState)
        }
        .menuBarExtraStyle(.menu)
    }
}

// MARK: - App Delegate

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    var appState: AppState?
    let updaterController: SPUStandardUpdaterController
    private var shouldShowSettingsWindow = false
    private var pendingURLRequests: [(url: URL, sourceAppBundleId: String?)] = []

    override init() {
        updaterController = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
        super.init()
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        if SettingsService().general.hideWindowOnStartup {
            hideDockIcon()
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Create data directories
        createAppDirectories()
        
        // Register for Apple Events to handle HTTP/HTTPS URLs
        NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(handleGetURLEvent(_:withReplyEvent:)), forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
        NotificationCenter.default.addObserver(self, selector: #selector(windowWillClose(_:)), name: NSWindow.willCloseNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(settingsWindowDidBecomeKey(_:)), name: NSWindow.didBecomeKeyNotification, object: nil)
        
        let settingsService = SettingsService()
        if settingsService.general.hideWindowOnStartup {
            hideDockIcon()
            DispatchQueue.main.async {
                NSApp.windows.first?.close()
            }
        } else {
            showDockIcon()
        }
    }

    func settingsWindowDidAppear() {
        shouldShowSettingsWindow = false
        flushPendingURLRequests()
        updateDockIconForVisibleWindows()
    }

    func prepareToOpenSettingsWindow() {
        shouldShowSettingsWindow = true
        showDockIcon()
    }

    func showExistingSettingsWindowIfPossible() -> Bool {
        guard let window = settingsWindow else { return false }

        shouldShowSettingsWindow = true
        showDockIcon()
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        return true
    }

    func showDockIcon() {
        if NSApp.activationPolicy() != .regular {
            NSApp.setActivationPolicy(.regular)
        }
    }

    func hideDockIcon() {
        if NSApp.activationPolicy() != .accessory {
            NSApp.setActivationPolicy(.accessory)
        }
    }

    @objc private func windowWillClose(_ notification: Notification) {
        DispatchQueue.main.async { [weak self] in
            self?.updateDockIconForVisibleWindows()
        }
    }

    @objc private func settingsWindowDidBecomeKey(_ notification: Notification) {
        guard let window = notification.object as? NSWindow,
              isSettingsWindow(window)
        else { return }
        showDockIcon()
    }

    private var settingsWindow: NSWindow? {
        NSApp.windows.first(where: isSettingsWindow)
    }

    private func isSettingsWindow(_ window: NSWindow) -> Bool {
        window.canBecomeMain && window.title == "BrowSync"
    }

    private func hasVisibleSettingsWindow() -> Bool {
        NSApp.windows.contains { window in
            isSettingsWindow(window) && window.isVisible && !window.isMiniaturized
        }
    }

    private func updateDockIconForVisibleWindows() {
        if hasVisibleSettingsWindow() {
            showDockIcon()
        } else {
            hideDockIcon()
        }
    }

    @objc func handleGetURLEvent(_ event: NSAppleEventDescriptor, withReplyEvent replyEvent: NSAppleEventDescriptor) {
        guard let urlString = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue,
              let url = URL(string: urlString) else { return }

        hideDockIconIfNoVisibleMainWindow()
        let sourceAppBundleId = sourceBundleIdentifier(from: event)

        if let appState {
            appState.handleIncomingURL(url, sourceAppBundleId: sourceAppBundleId)
        } else {
            pendingURLRequests.append((url: url, sourceAppBundleId: sourceAppBundleId))
        }
        hideDockIconIfNoVisibleMainWindow()
    }

    private func flushPendingURLRequests() {
        guard let appState, !pendingURLRequests.isEmpty else { return }
        let requests = pendingURLRequests
        pendingURLRequests.removeAll()

        for request in requests {
            appState.handleIncomingURL(request.url, sourceAppBundleId: request.sourceAppBundleId)
        }
        hideDockIconIfNoVisibleMainWindow()
    }

    private func hideDockIconIfNoVisibleMainWindow() {
        if !hasVisibleSettingsWindow() {
            hideDockIcon()
        }
    }

    private func sourceBundleIdentifier(from event: NSAppleEventDescriptor) -> String? {
        let selfBundleId = Bundle.main.bundleIdentifier
        let attributeKeys: [AEKeyword] = [keyOriginalAddressAttr, keyAddressAttr]

        for key in attributeKeys {
            guard let address = event.attributeDescriptor(forKeyword: key),
                  let bundleId = bundleIdentifier(fromAddressDescriptor: address),
                  bundleId != selfBundleId
            else { continue }
            return bundleId
        }

        if let frontmost = NSWorkspace.shared.frontmostApplication,
           frontmost.bundleIdentifier != selfBundleId {
            return frontmost.bundleIdentifier
        }

        return nil
    }

    private func bundleIdentifier(fromAddressDescriptor descriptor: NSAppleEventDescriptor) -> String? {
        if descriptor.descriptorType == typeApplicationBundleID,
           let bundleId = descriptor.stringValue {
            return bundleId
        }

        if let bundleDescriptor = descriptor.coerce(toDescriptorType: typeApplicationBundleID),
           let bundleId = bundleDescriptor.stringValue {
            return bundleId
        }

        if let pidDescriptor = descriptor.coerce(toDescriptorType: typeKernelProcessID) {
            let pid = pid_t(pidDescriptor.int32Value)
            if pid > 0 {
                return NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
            }
        }

        return nil
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false // Keep running as menu bar app
    }

    private func createAppDirectories() {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let dirs = [
            "BrowSync",
            "BrowSync/sites",
            "BrowSync/bookmarks",
            "BrowSync/history",
            "BrowSync/logs",
        ]
        for dir in dirs {
            let url = appSupport.appendingPathComponent(dir)
            try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        }
    }
}

// MARK: - Menu Bar View

struct MenuBarView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        // Installed Browsers Section
        ForEach(appState.browserInfos.filter { $0.isInstalled }) { info in
            Menu {
                Button(String(localized: "设为默认")) {
                    // Placeholder for set default
                    print("Set default: \(info.displayName)")
                }
                .disabled(info.isDefault)

                Button(String(localized: "打开 \(info.displayName)")) {
                    if let appURL = info.appURL {
                        NSWorkspace.shared.open(appURL)
                    }
                }
            } label: {
                Label {
                    Text("\(info.displayName)\(info.isDefault ? " (默认)" : "") • \(info.extensionStatus.displayName)")
                } icon: {
                    if let appURL = info.appURL {
                        Image(nsImage: NSWorkspace.shared.icon(forFile: appURL.path))
                    } else {
                        Image(systemName: info.id.sfSymbol)
                    }
                }
            }
        }

        Divider()

        // Current Domain Section
        if let domain = appState.activeDomain {
            Menu {
                Button("添加到网站名单") {
                    let newSetting = WebsiteSyncSetting(domain: domain, strategy: nil)
                    if !appState.settingsService.syncSettings.websiteSettings.contains(where: { $0.domain == domain }) {
                        appState.objectWillChange.send()
                        appState.settingsService.syncSettings.websiteSettings.append(newSetting)
                        appState.settingsService.save()
                    }
                }
            } label: {
                Text("当前网站 \(domain)")
            }

            Divider()
        }

        // Actions Section
        Button(String(localized: "立即同步")) {
            Task { await appState.syncAll() }
        }

        Button(String(localized: "设置")) {
            if (NSApp.delegate as? AppDelegate)?.showExistingSettingsWindowIfPossible() != true {
                (NSApp.delegate as? AppDelegate)?.prepareToOpenSettingsWindow()
                openWindow(id: "SettingsWindow")
            }
            NSApp.activate(ignoringOtherApps: true)
        }

        Button(String(localized: "检查更新...")) {
            (NSApp.delegate as? AppDelegate)?.updaterController.checkForUpdates(nil)
        }

        Divider()

        Button(String(localized: "退出")) {
            NSApp.terminate(nil)
        }
    }
}
