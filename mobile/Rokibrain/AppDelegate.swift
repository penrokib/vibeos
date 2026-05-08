import UIKit
import UserNotifications

// MARK: - AppDelegate (Cycle 25)
//
// Wires APNs registration and remote notification receipt.
// Registered via @UIApplicationDelegateAdaptor in RokibrainApp.
//
// Hardwall: no third-party packages.
// Hardwall: wake-word is default OFF (D39) — PTT only in this PR.

final class AppDelegate: NSObject, UIApplicationDelegate {

    // MARK: - Finish launching

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Register for remote notifications only if the user already granted
        // push permission during onboarding (cycle 26 EnablePushStep).
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized else { return }
            DispatchQueue.main.async {
                application.registerForRemoteNotifications()
            }
        }
        return true
    }

    // MARK: - Token received

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in
            await PushTokenStore.shared.register(deviceToken: deviceToken)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // Transient sandbox errors are expected in the Simulator; ignore silently.
        // Production failures surface via PushTokenStore.registrationError.
    }

    // MARK: - Notification received (foreground + background)

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        handleDeepLink(userInfo: userInfo)
        completionHandler(.newData)
    }

    // MARK: - Deep-link routing

    private func handleDeepLink(userInfo: [AnyHashable: Any]) {
        guard let deepLink = userInfo["deepLink"] as? String else { return }
        // Post to NotificationCenter so any active tab can pick it up.
        // Tabs observe DeepLinkNotification.name and navigate accordingly.
        NotificationCenter.default.post(
            name: DeepLinkNotification.name,
            object: nil,
            userInfo: ["deepLink": deepLink]
        )
    }
}

// MARK: - DeepLinkNotification

enum DeepLinkNotification {
    static let name = Notification.Name("vibeos.deepLink")
}
