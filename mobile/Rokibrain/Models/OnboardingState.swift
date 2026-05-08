import Foundation

enum OnboardingStep: Int, Codable {
    case welcome = 0
    case signIn = 1
    case pairMac = 2
    case enablePush = 3
    case done = 4
}
