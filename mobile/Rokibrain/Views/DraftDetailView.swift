import SwiftUI

// MARK: - DraftDetailView

struct DraftDetailView: View {
    let draft: DraftDetail

    @Environment(DraftsStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var isEditing: Bool = false
    @State private var editedBody: String = ""
    @State private var similarExpanded: Bool = false
    @State private var showRejectSheet: Bool = false
    @State private var rejectReason: String = ""
    @State private var actionError: String?

    private var isProcessing: Bool { store.processing.contains(draft.id) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // HEADER
                headerSection
                    .padding(.horizontal)
                    .padding(.top, 16)

                Divider().padding(.vertical, 12)

                // REFUSAL BANNER (if refused)
                if draft.status == "refused", let reason = draft.refusalReason {
                    refusalBanner(reason: reason)
                        .padding(.horizontal)
                        .padding(.bottom, 12)
                }

                // Error banner
                if let err = actionError {
                    actionErrorBanner(message: err)
                        .padding(.horizontal)
                        .padding(.bottom, 12)
                }

                // PERSONA
                sectionHeader("Persona")
                personaSection
                    .padding(.horizontal)
                    .padding(.bottom, 16)

                // DRAFT BODY
                sectionHeader("Draft")
                draftBodySection
                    .padding(.horizontal)
                    .padding(.bottom, 16)

                // THREAD CONTEXT
                if let thread = draft.threadContext, !thread.isEmpty {
                    sectionHeader("Thread Context (last \(thread.count))")
                    threadSection(thread)
                        .padding(.horizontal)
                        .padding(.bottom, 16)
                }

                // SIMILAR PAST DRAFTS
                if let similar = draft.similarPastDrafts, !similar.isEmpty {
                    sectionHeader("Similar Past Drafts")
                    similarSection(similar)
                        .padding(.horizontal)
                        .padding(.bottom, 16)
                }

                // RECIPIENT PROFILE
                if let profile = draft.recipientProfile {
                    sectionHeader("Recipient Profile")
                    recipientProfileSection(profile)
                        .padding(.horizontal)
                        .padding(.bottom, 16)
                }

                // Spacer for bottom action bar
                Spacer(minLength: 90)
            }
        }
        .navigationTitle(draft.recipientName ?? draft.recipient)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            actionBar
        }
        .sheet(isPresented: $showRejectSheet) {
            rejectSheet
        }
        .onAppear {
            editedBody = draft.body
        }
    }

    // MARK: - Header section

    private var headerSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                platformBadge
                accountChip(draft.account)
                Spacer()
                Text(draft.createdAt.formatted(.relative(presentation: .named)))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            HStack(spacing: 6) {
                Image(systemName: "arrow.right.circle")
                    .foregroundStyle(.secondary)
                    .font(.caption)
                Text(draft.recipientName ?? draft.recipient)
                    .font(.subheadline)
                    .bold()
                if draft.recipient != (draft.recipientName ?? draft.recipient) {
                    Text("(\(draft.recipient))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    // MARK: - Persona section

    private var personaSection: some View {
        HStack(alignment: .top, spacing: 12) {
            personaAvatar
            VStack(alignment: .leading, spacing: 6) {
                Text(draft.persona)
                    .font(.subheadline)
                    .bold()
                if let reasoning = draft.personaReasoning {
                    Text(reasoning)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(12)
        .background(Color.secondary.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private var personaAvatar: some View {
        ZStack {
            Circle()
                .fill(Color.purple.opacity(0.2))
                .frame(width: 36, height: 36)
            Text(String(draft.persona.prefix(1)).uppercased())
                .font(.subheadline)
                .bold()
                .foregroundStyle(.purple)
        }
    }

    // MARK: - Draft body section

    private var draftBodySection: some View {
        Group {
            if isEditing {
                TextEditor(text: $editedBody)
                    .font(.body)
                    .frame(minHeight: 140)
                    .padding(8)
                    .background(Color.secondary.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(Color.accentColor, lineWidth: 1.5)
                    )
            } else {
                Text(draft.body)
                    .font(.body)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.secondary.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
            }
        }
    }

    // MARK: - Thread context section

    private func threadSection(_ messages: [DraftThreadMessage]) -> some View {
        VStack(spacing: 8) {
            ForEach(messages) { msg in
                HStack {
                    if msg.direction == "outbound" { Spacer(minLength: 40) }
                    VStack(alignment: msg.direction == "outbound" ? .trailing : .leading, spacing: 2) {
                        Text(msg.content)
                            .font(.footnote)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 7)
                            .background(
                                msg.direction == "outbound"
                                    ? Color.accentColor.opacity(0.85)
                                    : Color.secondary.opacity(0.18)
                            )
                            .foregroundStyle(msg.direction == "outbound" ? Color.white : Color.primary)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                        Text(msg.ts.formatted(.relative(presentation: .named)))
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    if msg.direction == "inbound" { Spacer(minLength: 40) }
                }
            }
        }
    }

    // MARK: - Similar past drafts section

    private func similarSection(_ ids: [String]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    similarExpanded.toggle()
                }
            } label: {
                HStack {
                    Text(similarExpanded ? "Hide similar drafts" : "Show \(ids.count) similar draft\(ids.count == 1 ? "" : "s")")
                        .font(.footnote)
                        .foregroundStyle(Color.accentColor)
                    Spacer()
                    Image(systemName: similarExpanded ? "chevron.up" : "chevron.down")
                        .font(.caption)
                        .foregroundStyle(Color.accentColor)
                }
            }
            .buttonStyle(.plain)

            if similarExpanded {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(ids, id: \.self) { id in
                        HStack(spacing: 6) {
                            Image(systemName: "doc.text")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            Text(id)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                }
                .padding(.top, 4)
            }
        }
        .padding(12)
        .background(Color.secondary.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Recipient profile section

    private func recipientProfileSection(_ profile: DraftRecipientProfile) -> some View {
        HStack(spacing: 0) {
            profileStat(label: "Sent", value: "\(profile.totalSent)")
            Divider().frame(height: 32)
            profileStat(label: "Received", value: "\(profile.totalReceived)")
            Divider().frame(height: 32)
            if let last = profile.lastInteraction {
                profileStat(label: "Last contact", value: last.formatted(.relative(presentation: .named)))
            } else {
                profileStat(label: "Last contact", value: "Never")
            }
        }
        .padding(12)
        .background(Color.secondary.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func profileStat(label: String, value: String) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.subheadline)
                .bold()
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Refusal banner

    private func refusalBanner(reason: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.octagon.fill")
                .foregroundStyle(.red)
            VStack(alignment: .leading, spacing: 2) {
                Text("Refused by system")
                    .font(.footnote)
                    .bold()
                    .foregroundStyle(.red)
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.red.opacity(0.9))
            }
            Spacer()
        }
        .padding(12)
        .background(Color.red.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Action error banner

    private func actionErrorBanner(message: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            Text(message)
                .font(.footnote)
                .foregroundStyle(.orange)
            Spacer()
            Button {
                actionError = nil
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.orange)
            }
            .buttonStyle(.plain)
        }
        .padding(12)
        .background(Color.orange.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Bottom action bar

    private var actionBar: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 12) {
                // Reject
                Button {
                    showRejectSheet = true
                } label: {
                    Label("Reject", systemImage: "xmark.circle")
                        .font(.subheadline)
                        .bold()
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(.red)
                .disabled(isProcessing)

                // Edit / Cancel edit
                Button {
                    if isEditing {
                        // Cancel edit — restore original
                        editedBody = draft.body
                        isEditing = false
                    } else {
                        isEditing = true
                    }
                } label: {
                    Label(isEditing ? "Cancel" : "Edit", systemImage: isEditing ? "xmark" : "pencil")
                        .font(.subheadline)
                        .bold()
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(.secondary)
                .disabled(isProcessing)

                // Approve / Send edited
                Button {
                    Task { await handleApprove() }
                } label: {
                    Group {
                        if isProcessing {
                            ProgressView()
                                .progressViewStyle(.circular)
                                .tint(.white)
                        } else {
                            Label(isEditing ? "Send edited" : "Approve", systemImage: isEditing ? "paperplane.fill" : "checkmark.circle.fill")
                                .font(.subheadline)
                                .bold()
                        }
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(.green)
                .disabled(isProcessing)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(.regularMaterial)
        }
    }

    // MARK: - Reject sheet

    private var rejectSheet: some View {
        NavigationStack {
            Form {
                Section(header: Text("Rejection reason (optional)")) {
                    TextField("Why reject this draft?", text: $rejectReason, axis: .vertical)
                        .lineLimit(3...6)
                }
            }
            .navigationTitle("Reject Draft")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        showRejectSheet = false
                        rejectReason = ""
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Reject") {
                        showRejectSheet = false
                        Task { await handleReject() }
                    }
                    .bold()
                    .tint(.red)
                }
            }
        }
        .presentationDetents([.medium])
    }

    // MARK: - Actions

    private func handleApprove() async {
        actionError = nil
        do {
            if isEditing && editedBody != draft.body {
                // Update first, then approve
                try await store.update(id: draft.id, newBody: editedBody)
            }
            try await store.approve(id: draft.id)
            dismiss()
        } catch let apiError as APIError {
            actionError = apiError.errorDescription ?? "Failed to approve"
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func handleReject() async {
        actionError = nil
        do {
            let reason = rejectReason.trimmingCharacters(in: .whitespacesAndNewlines)
            try await store.reject(id: draft.id, reason: reason.isEmpty ? nil : reason)
            rejectReason = ""
            dismiss()
        } catch let apiError as APIError {
            actionError = apiError.errorDescription ?? "Failed to reject"
        } catch {
            actionError = error.localizedDescription
        }
    }

    // MARK: - Helpers

    private func sectionHeader(_ title: String) -> some View {
        Text(title.uppercased())
            .font(.caption)
            .bold()
            .foregroundStyle(.secondary)
            .padding(.horizontal)
            .padding(.bottom, 6)
    }

    private var platformBadge: some View {
        let (name, color): (String, Color) = {
            switch draft.platform {
            case "linkedin":  return ("person.crop.square.filled.and.at.rectangle", .blue)
            case "whatsapp":  return ("message.fill", .green)
            case "email":     return ("envelope.fill", .orange)
            case "telegram":  return ("paperplane.fill", .cyan)
            case "instagram": return ("camera.fill", .pink)
            default:          return ("bubble.left.fill", .secondary)
            }
        }()
        return Label(draft.platform.capitalized, systemImage: name)
            .font(.caption)
            .bold()
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color.opacity(0.15))
            .foregroundStyle(color)
            .clipShape(Capsule())
    }

    private func accountChip(_ account: String) -> some View {
        Text(account)
            .font(.caption2)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color.accentColor.opacity(0.12))
            .foregroundStyle(Color.accentColor)
            .clipShape(Capsule())
            .lineLimit(1)
    }
}
