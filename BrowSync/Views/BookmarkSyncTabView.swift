// BookmarkSyncTabView.swift
// BrowSync — Bookmark Sync Tab

import SwiftUI

struct BookmarkSyncTabView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var backupService: BackupService
    @EnvironmentObject var langBundle: LanguageBundle
    @State private var isSyncing = false
    @State private var showSuccess = false
    @State private var backupToDelete: BookmarkBackup?
    @State private var showingDeleteConfirmation = false
    
    private var syncSettings: Binding<SyncSettings> {
        Binding(
            get: { appState.settingsService.syncSettings },
            set: {
                appState.objectWillChange.send()
                appState.settingsService.syncSettings = $0
                appState.settingsService.save()
            }
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(String(localized: "Bookmark Sync Title", bundle: langBundle.bundle))
                    .font(.title2.bold())
                
                Spacer()
                
                Toggle(String(localized: "Enable Bookmark Sync", bundle: langBundle.bundle), isOn: Binding(
                    get: { syncSettings.enabledCategories.wrappedValue.contains(.bookmarks) },
                    set: { enabled in
                        if enabled {
                            syncSettings.wrappedValue.enabledCategories.insert(.bookmarks)
                        } else {
                            syncSettings.wrappedValue.enabledCategories.remove(.bookmarks)
                        }
                    }
                ))
                .toggleStyle(.switch)
                
                Button {
                    Task {
                        isSyncing = true
                        await appState.sync(categories: [.bookmarks])
                        isSyncing = false
                        showSuccess = true
                        try? await Task.sleep(nanoseconds: 2_000_000_000)
                        showSuccess = false
                    }
                } label: {
                    if isSyncing || appState.syncService.isSyncing {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.small)
                            Text(String(localized: "Syncing...", bundle: langBundle.bundle))
                        }
                    } else if showSuccess {
                        Label(String(localized: "Sync Complete", bundle: langBundle.bundle), systemImage: "checkmark.circle.fill")
                    } else {
                        Label(String(localized: "Sync Now", bundle: langBundle.bundle), systemImage: "arrow.triangle.2.circlepath")
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(showSuccess ? .green : .accentColor)
                .disabled(isSyncing || appState.syncService.isSyncing || showSuccess || !syncSettings.enabledCategories.wrappedValue.contains(.bookmarks))
            }
            .padding()

            Form {
                Section(String(localized: "Participating Browsers", bundle: langBundle.bundle)) {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 12) {
                            ForEach(appState.browserInfos.filter { $0.isInstalled }) { info in
                                Toggle(isOn: Binding(
                                    get: { syncSettings.bookmarkParticipatingBrowsers.wrappedValue.contains(info.browser) },
                                    set: { isParticipating in
                                        if isParticipating {
                                            syncSettings.wrappedValue.bookmarkParticipatingBrowsers.insert(info.browser)
                                        } else {
                                            syncSettings.wrappedValue.bookmarkParticipatingBrowsers.remove(info.browser)
                                        }
                                    }
                                )) {
                                    HStack(spacing: 6) {
                                        if let url = info.appURL {
                                            Image(nsImage: NSWorkspace.shared.icon(forFile: url.path))
                                                .resizable()
                                                .frame(width: 16, height: 16)
                                        } else {
                                            Image(systemName: info.id.sfSymbol)
                                                .frame(width: 16, height: 16)
                                        }
                                        Text(info.displayName)
                                    }
                                }
                                .toggleStyle(.checkbox)
                            }
                        }
                        .padding(.vertical, 8)
                        .padding(.horizontal, 4)
                    }
                }

                Section(String(localized: "Sync Strategy", bundle: langBundle.bundle)) {
                    Picker(String(localized: "Bookmark Strategy", bundle: langBundle.bundle), selection: syncSettings.bookmarkSyncStrategy) {
                        ForEach(BookmarkSyncStrategy.allCases) { strategy in
                            Text(strategy.displayName).tag(strategy)
                        }
                    }
                    .pickerStyle(.menu)
                
                    if syncSettings.bookmarkSyncStrategy.wrappedValue == .oneWay {
                        Picker(String(localized: "Bookmark Source Browser", bundle: langBundle.bundle), selection: syncSettings.bookmarkSourceBrowser) {
                            ForEach(appState.browserInfos.filter { $0.isInstalled }) { info in
                                Label {
                                    Text(info.displayName)
                                } icon: {
                                    AppIconImage(appURL: info.appURL)
                                }
                                .tag(info.browser)
                            }
                        }
                        .pickerStyle(.menu)
                        
                        if syncSettings.bookmarkSourceBrowser.wrappedValue == .safari && !appState.hasFullDiskAccess {
                            VStack(alignment: .leading, spacing: 10) {
                                HStack {
                                    Image(systemName: "exclamationmark.shield.fill")
                                        .foregroundStyle(.red)
                                    Text(String(localized: "Cannot read Safari bookmarks", bundle: langBundle.bundle))
                                        .font(.headline)
                                        .foregroundStyle(.red)
                                }
                                
                                Text(String(localized: "Safari privacy warning", bundle: langBundle.bundle))
                                    .font(.caption)
                                    .fixedSize(horizontal: false, vertical: true)
                                
                                HStack {
                                    Button(String(localized: "Grant in System Settings", bundle: langBundle.bundle)) {
                                        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles") {
                                            NSWorkspace.shared.open(url)
                                        }
                                    }
                                    .buttonStyle(.bordered)
                                    .controlSize(.small)
                                    
                                    Button(String(localized: "Already granted, refresh", bundle: langBundle.bundle)) {
                                        appState.checkFullDiskAccess()
                                    }
                                    .buttonStyle(.link)
                                    .controlSize(.small)
                                }
                                
                                Text(String(localized: "Note restart", bundle: langBundle.bundle))
                                    .font(.system(size: 10))
                                    .foregroundStyle(.secondary)
                            }
                            .padding()
                            .background(Color.red.opacity(0.1))
                            .cornerRadius(8)
                            .padding(.vertical, 4)
                        }
                    }
                    
                    Toggle(String(localized: "Auto Bookmark Sync", bundle: langBundle.bundle), isOn: syncSettings.bookmarkAutoSync)
                }
                if (syncSettings.bookmarkSyncStrategy.wrappedValue == .twoWayMerge || 
                   (syncSettings.bookmarkSyncStrategy.wrappedValue == .oneWay && syncSettings.bookmarkSourceBrowser.wrappedValue == .safari)) 
                   && !appState.hasFullDiskAccess {
                    Section {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                Image(systemName: "exclamationmark.shield.fill")
                                    .foregroundStyle(.red)
                                Text(String(localized: "Cannot read Safari bookmarks", bundle: langBundle.bundle))
                                    .font(.headline)
                                    .foregroundStyle(.red)
                            }
                            
                            Text(String(localized: "Safari privacy warning 2", bundle: langBundle.bundle))
                                .font(.caption)
                                .fixedSize(horizontal: false, vertical: true)
                            
                            HStack {
                                Button(String(localized: "Grant in System Settings", bundle: langBundle.bundle)) {
                                    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles") {
                                        NSWorkspace.shared.open(url)
                                    }
                                }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                                
                                Button(String(localized: "Already granted, refresh", bundle: langBundle.bundle)) {
                                    appState.checkFullDiskAccess()
                                }
                                .buttonStyle(.link)
                                .controlSize(.small)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
                
                Section(String(localized: "Sync History and Backups", bundle: langBundle.bundle)) {
                    if backupService.backups.isEmpty {
                        Text(String(localized: "No backups", bundle: langBundle.bundle))
                            .foregroundStyle(.secondary)
                    } else {
                        Text(String(localized: "Backup retention note", bundle: langBundle.bundle))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        
                        ForEach(backupService.backups) { backup in
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(backup.timestamp.formatted(date: .numeric, time: .shortened))
                                        .font(.headline)
                                    HStack(spacing: 4) {
                                        let sourceId = backup.sourceBrowser.replacingOccurrences(of: "_before_sync", with: "").components(separatedBy: "-").first ?? backup.sourceBrowser
                                        let browserInfo = appState.browserInfos.first(where: { $0.browser.rawValue == sourceId })
                                        
                                        if let browserInfo = browserInfo {
                                            AppIconImage(appURL: browserInfo.appURL, size: 12)
                                        } else {
                                            Image(systemName: "app")
                                                .resizable()
                                                .frame(width: 12, height: 12)
                                                .foregroundColor(.secondary)
                                        }
                                        let displayName = browserInfo?.displayName ?? sourceId
                                        Text(String(format: String(localized: "Source: %@ (%lld items)", bundle: langBundle.bundle), displayName, backup.itemCount))
                                    }
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                }
                                
                                Spacer()
                                
                                Button(String(localized: "Restore this version", bundle: langBundle.bundle)) {
                                    restoreBackup(backup)
                                }
                                .buttonStyle(.bordered)
                                .tint(.orange)
                                
                                Button(action: {
                                    backupToDelete = backup
                                    showingDeleteConfirmation = true
                                }) {
                                    Image(systemName: "trash")
                                }
                                .buttonStyle(.plain)
                                .foregroundColor(.red)
                                .padding(.leading, 8)
                            }
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .disabled(!syncSettings.enabledCategories.wrappedValue.contains(.bookmarks))
            .alert(
                String(localized: "Confirm delete backup", bundle: langBundle.bundle),
                isPresented: $showingDeleteConfirmation,
                presenting: backupToDelete
            ) { backup in
                Button(String(localized: "Delete", bundle: langBundle.bundle), role: .destructive) {
                    backupService.deleteBackup(id: backup.id)
                }
                Button(String(localized: "Cancel", bundle: langBundle.bundle), role: .cancel) {}
            } message: { backup in
                Text(String(localized: "Delete backup message", bundle: langBundle.bundle))
            }
        }
    }
    
    private func restoreBackup(_ backup: BookmarkBackup) {
        guard let bookmarks = backupService.getBookmarks(for: backup.id) else { return }
        
        if backup.sourceBrowser == "safari" {
            // Apply only to Safari natively
            let syncBookmarks = bookmarks.compactMap { b -> SyncBookmark? in
                let urlStr: String?
                if let urlOpt = b.url { urlStr = urlOpt } else { urlStr = nil }
                if !b.isFolder && urlStr == nil { return nil }
                return SyncBookmark(id: b.id, title: b.title, url: urlStr, parentId: b.parentId, isFolder: b.isFolder, inBookmarksBar: b.inBookmarksBar ?? false)
            }
            let safariSvc = SafariBookmarkService()
            safariSvc.applyBookmarks(syncBookmarks, from: backup.sourceBrowser, isFullMirror: true)
        } else {
            // Send back to the specific Chromium extension it came from
            let pushMsg = WSMessage(
                type: .sync,
                site: "*",
                category: "bookmarks",
                payload: .bookmarks(bookmarks),
                messageId: UUID().uuidString,
                timestamp: Date().timeIntervalSince1970,
                isFullMirror: true // Force overwrite
            )
            
            let clientId = backup.sourceBrowser.replacingOccurrences(of: "_before_sync", with: "")
            appState.daemon.send(pushMsg, toClientId: clientId)
        }
        
        showSuccess = true
        Task {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            showSuccess = false
        }
    }
}
