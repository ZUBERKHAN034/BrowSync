// LanguageBundle.swift
// BrowSync — Runtime language switching support
//
// SwiftUI's .environment(\.locale) only affects Text views with LocalizedStringKey literals.
// String(localized:) always uses Bundle.main resolved at OS level and ignores locale env.
// This class provides a Bundle resolved from the correct .lproj resource directory,
// which can then be passed to String(localized:bundle:) and Text(_:bundle:) to support
// immediate in-app language switching without requiring a restart.

import Foundation
import Combine

@MainActor
final class LanguageBundle: ObservableObject {
    @Published private(set) var bundle: Bundle = .main

    nonisolated static var systemBundle: Bundle {
        let globalLangs = UserDefaults.standard.persistentDomain(forName: UserDefaults.globalDomain)?["AppleLanguages"] as? [String]
        let fallbackLangs = globalLangs ?? Locale.preferredLanguages
        
        if let preferred = Bundle.preferredLocalizations(from: Bundle.main.localizations, forPreferences: fallbackLangs).first,
           let lprojPath = Bundle.main.path(forResource: preferred, ofType: "lproj"),
           let resolved = Bundle(path: lprojPath) {
            return resolved
        }
        return .main
    }

    init(language: AppLanguage) {
        apply(language: language)
    }

    func apply(language: AppLanguage) {
        let preferredLanguages: [String]
        if language == .system {
            preferredLanguages = Locale.preferredLanguages
        } else {
            preferredLanguages = [language.rawValue]
        }

        // Use Apple's built-in robust localization matching (automatically handles zh-Hans-CN -> zh-Hans etc.)
        if let preferred = Bundle.preferredLocalizations(from: Bundle.main.localizations, forPreferences: preferredLanguages).first,
           let lprojPath = Bundle.main.path(forResource: preferred, ofType: "lproj"),
           let resolved = Bundle(path: lprojPath) {
            bundle = resolved
        } else {
            bundle = .main
        }
    }
}
