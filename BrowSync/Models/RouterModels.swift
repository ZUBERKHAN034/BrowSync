import Foundation

enum RuleConditionField: String, CaseIterable, Codable, Identifiable {
    case domain = "Domain"
    case url = "URL"
    case queryString = "Query String"
    case sourceApp = "Source App"
    case timePeriod = "Time Period"
    
    var id: String { rawValue }
    
    var displayName: LocalizedStringResource {
        switch self {
        case .domain: return "Domain"
        case .url: return "URL"
        case .queryString: return "Query String"
        case .sourceApp: return "Source App"
        case .timePeriod: return "Time Period"
        }
    }
}

enum RuleConditionOperator: String, CaseIterable, Codable, Identifiable {
    case equals = "Equals"
    case notEquals = "Not Equals"
    case contains = "Contains"
    case excludes = "Excludes"
    case startsWith = "Starts With"
    case endsWith = "Ends With"
    case matchesRegex = "Matches Regex"
    case wildcard = "Wildcard"
    
    var id: String { rawValue }
    
    var displayName: LocalizedStringResource {
        switch self {
        case .equals: return "Equals"
        case .notEquals: return "Not Equals"
        case .contains: return "Contains"
        case .excludes: return "Excludes"
        case .startsWith: return "Starts With"
        case .endsWith: return "Ends With"
        case .matchesRegex: return "Regex Match"
        case .wildcard: return "Wildcard Match"
        }
    }
}

enum RuleConditionLogic: String, CaseIterable, Codable, Identifiable {
    case and = "AND"
    case or = "OR"
    
    var id: String { rawValue }
    
    var displayName: LocalizedStringResource {
        switch self {
        case .and: return "All Conditions"
        case .or: return "Any Condition"
        }
    }
}

struct RuleCondition: Identifiable, Codable, Equatable {
    var id = UUID()
    var field: RuleConditionField = .domain
    var `operator`: RuleConditionOperator = .contains
    var value: String = ""
    
    // For Time Period (HH:mm-HH:mm format)
    var startTime: Date?
    var endTime: Date?
    
    var summaryText: String {
        if field == .timePeriod {
            let formatter = DateFormatter()
            formatter.timeStyle = .short
            let s = startTime.map { formatter.string(from: $0) } ?? "?"
            let e = endTime.map { formatter.string(from: $0) } ?? "?"
            return String(localized: "\(field.displayName) \(s) to \(e)")
        } else {
            return String(localized: "\(field.displayName) \(self.operator.displayName) \(value)")
        }
    }
}

struct RouterRule: Identifiable, Codable, Equatable {
    var id = UUID()
    var name: String = "New Rule"
    var isEnabled: Bool = true
    var logic: RuleConditionLogic = .and
    var conditions: [RuleCondition] = []
    var targetBrowserId: String? // nil means use default fallback
    
    var summaryText: String {
        if conditions.isEmpty { return String(localized: "No conditions") }
        let joinString = logic == .and ? String(localized: " AND ") : String(localized: " OR ")
        return conditions.map { $0.summaryText }.joined(separator: joinString)
    }
    
    // Evaluate if this rule matches a given request
    func evaluate(url: URL, sourceAppBundleId: String?, currentTime: Date = Date()) -> Bool {
        guard isEnabled, !conditions.isEmpty else { return false }
        
        let evaluations = conditions.map { condition in
            evaluateCondition(condition, url: url, sourceAppBundleId: sourceAppBundleId, currentTime: currentTime)
        }
        
        switch logic {
        case .and:
            return evaluations.allSatisfy { $0 }
        case .or:
            return evaluations.contains(true)
        }
    }
    
    private func evaluateCondition(_ condition: RuleCondition, url: URL, sourceAppBundleId: String?, currentTime: Date) -> Bool {
        switch condition.field {
        case .domain:
            let domain = url.host ?? ""
            return compareString(domain, operator: condition.operator, value: condition.value)
        case .url:
            let urlString = url.absoluteString
            return compareString(urlString, operator: condition.operator, value: condition.value)
        case .queryString:
            let query = url.query ?? ""
            return compareString(query, operator: condition.operator, value: condition.value)
        case .sourceApp:
            let source = sourceAppBundleId ?? ""
            return compareString(source, operator: condition.operator, value: condition.value)
        case .timePeriod:
            guard let start = condition.startTime, let end = condition.endTime else { return false }
            let calendar = Calendar.current
            let currentComponents = calendar.dateComponents([.hour, .minute], from: currentTime)
            let startComponents = calendar.dateComponents([.hour, .minute], from: start)
            let endComponents = calendar.dateComponents([.hour, .minute], from: end)
            
            let currentMinutes = (currentComponents.hour ?? 0) * 60 + (currentComponents.minute ?? 0)
            let startMinutes = (startComponents.hour ?? 0) * 60 + (startComponents.minute ?? 0)
            let endMinutes = (endComponents.hour ?? 0) * 60 + (endComponents.minute ?? 0)
            
            if startMinutes <= endMinutes {
                return currentMinutes >= startMinutes && currentMinutes <= endMinutes
            } else {
                // Crosses midnight
                return currentMinutes >= startMinutes || currentMinutes <= endMinutes
            }
        }
    }
    
    private func compareString(_ target: String, operator op: RuleConditionOperator, value: String) -> Bool {
        let t = target.lowercased()
        let v = value.lowercased()
        
        switch op {
        case .equals: return t == v
        case .notEquals: return t != v
        case .contains: return t.contains(v)
        case .excludes: return !t.contains(v)
        case .startsWith: return t.hasPrefix(v)
        case .endsWith: return t.hasSuffix(v)
        case .matchesRegex:
            if let regex = try? NSRegularExpression(pattern: value, options: .caseInsensitive) {
                return regex.firstMatch(in: target, options: [], range: NSRange(location: 0, length: target.utf16.count)) != nil
            }
            return false
        case .wildcard:
            // simple wildcard implementation mapping * to .* and ? to .
            let pattern = "^" + value.replacingOccurrences(of: "*", with: ".*").replacingOccurrences(of: "?", with: ".") + "$"
            if let regex = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) {
                return regex.firstMatch(in: target, options: [], range: NSRange(location: 0, length: target.utf16.count)) != nil
            }
            return false
        }
    }
}
