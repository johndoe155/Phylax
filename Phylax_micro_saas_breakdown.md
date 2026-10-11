# Phylax — Micro-SaaS Concept Breakdown

> **Working project name:** Phylax  
> **Product category:** Cross-platform shift conflict detection for per-diem healthcare workers  
> **Primary users:** Gig-economy CNAs, LPNs, and RNs who accept shifts across multiple staffing apps  
> **Core promise:** Prevent a worker from accidentally double-booking shifts—and tell them which commitment is safer to cancel and by when.

---

## 1. Executive Summary

**Phylax** is a lightweight web app/PWA that helps per-diem healthcare workers coordinate shifts accepted through multiple on-demand staffing platforms, including services such as ShiftKey, CareRev, Clipboard Health, ShiftMed, and IntelyCare.

The product does **not** attempt to replace those platforms, scrape them, or integrate with their private systems. Instead, it gives workers one fast, independent place to log accepted shifts manually. Each new shift is checked against existing shifts for:

1. **Direct time overlap** — two shifts occurring at the same time.
2. **Insufficient travel/commute buffer** — consecutive shifts at different facilities that leave too little time to travel between them.
3. **Cancellation-policy exposure** — the alert identifies the relevant platform’s cancellation-penalty window so the worker can decide which shift is safer to drop and how much time remains.

The intended experience is a **single guardrail**, not a full scheduling system:

> **Platform → Saved shift template → Date → Save**

The concept is designed for a rapid initial build because it relies on a self-contained data model and conflict algorithm rather than brittle third-party integrations. The proposed business model is approximately **$9 per month** or **$79 per year**, with a free tier limited by the number of active tracked shifts.

---

## 2. Why This Concept Emerged

The original idea-generation process evaluated several apparently attractive micro-SaaS opportunities, including:

- Dev-team reminder or “nagger” bots
- Shipping-cost audits
- Resale-profit trackers
- Security scanners for AI-generated applications
- Commercial lease/CAM reconciliation audits
- Trucking detention-pay tools

The key finding was that many ideas that seem novel at the brainstorming stage already have active competitors. In addition, the fastest-to-build concepts often hide a much larger operational burden: integrations, scraping, platform UI changes, or third-party data dependencies.

The strategic lesson was:

> AI has lowered the cost of building obvious software ideas, so differentiation must come from a narrow audience, a raw and underserved workflow, and a mechanism simple enough to ship and maintain.

Phylax follows that principle by choosing:

- A specific, underserved healthcare-worker niche
- A painful but narrow workflow
- Manual entry instead of platform integrations
- One core decision-support mechanism: conflict detection

---

## 3. Target Customer and Context

### 3.1 Primary customer

The primary customer is a gig-economy healthcare worker who uses multiple staffing apps to assemble income from per-diem shifts. This includes:

- Certified Nursing Assistants (CNAs)
- Licensed Practical Nurses (LPNs)
- Registered Nurses (RNs)

The worker may use several staffing platforms simultaneously because no single platform reliably supplies all desired shifts, facilities, hours, or rates.

### 3.2 Behavioral context

These workers are likely to:

- Accept shifts from different apps during the same week
- Maintain commitments at multiple facilities
- Reuse common shift patterns, such as 7 a.m.–7 p.m. or 7 p.m.–7 a.m.
- Make decisions quickly, often from a phone
- Have little tolerance for typing or administrative overhead
- Need immediate answers when a new shift creates a conflict
- Face financial or account consequences when a shift is cancelled too late or missed

### 3.3 Why existing platform calendars are insufficient

Each staffing platform can generally see only the shifts accepted through its own system. No platform has a complete view of the worker’s commitments elsewhere. The worker is therefore forced to manually cross-check several applications.

That creates a coordination gap:

- App A sees the App A shift.
- App B sees the App B shift.
- The worker must act as the synchronization layer.
- Human memory and manual checking fail under time pressure.

---

## 4. Core Pain Point

A worker can accept a shift on one platform without realizing that they already committed to an overlapping or nearly impossible shift on another platform.

The consequences may include:

- Double-booking
- Late arrival or no-show
- Cancellation penalties
- Loss of access or standing on a platform
- Lost income
- Uncompensated cancellations or shortened shifts
- Stress caused by repeatedly reconciling multiple apps

The important product insight is that the user does not necessarily need another calendar. They need a **fast, reliable moment-of-decision warning** immediately after entering a new commitment.

---

## 5. Product Positioning

### 5.1 Positioning statement

> **Phylax protects per-diem healthcare workers from accidental double-bookings across staffing apps by checking every accepted shift for time conflicts, travel-buffer problems, and cancellation risk.**

### 5.2 What Phylax is

- A cross-platform shift log
- A conflict-detection guardrail
- A mobile-first decision-support tool
- A lightweight PWA-capable web app
- A notification service for urgent conflicts and approaching shifts

### 5.3 What Phylax is not

- Not a staffing marketplace
- Not a replacement for ShiftKey, CareRev, Clipboard Health, ShiftMed, IntelyCare, or similar services
- Not a job-search product
- Not a full workforce-management suite
- Not an automated scheduler or optimizer
- Not a scraper of third-party platforms
- Not a payroll, timesheet, or clinical-record system

Keeping this boundary clear is important. The product wins by doing one job quickly rather than becoming another administrative system.

---

## 6. Core User Loop

The locked interaction model is:

1. **Select platform**
2. **Select saved shift template**
3. **Confirm date**
4. **Save**
5. **Receive an immediate conflict result, if applicable**

### 6.1 Typical case: saved template

Example:

- User taps the ShiftKey icon.
- User taps “Riverside Manor · Day 7–7.”
- Date defaults to “Today.”
- User taps Save.
- Phylax checks the new shift against the user’s current shifts.
- If a conflict exists, the warning appears immediately and an SMS can be sent.

### 6.2 Exceptional case: new facility or unusual time

For a new facility, the user can select **+ New facility** inline rather than leaving the flow for Settings.

For an off-pattern shift, the user can use a time picker. The design goal is that this is an exception path rather than the normal logging path.

### 6.3 Removal flow

Because healthcare shifts may be cancelled frequently, deleting or cancelling a logged shift must be as fast as adding one.

Recommended interaction:

- Swipe a shift card to cancel/remove it, or
- Use a prominent, low-friction cancel action on the card

The removal action should not require a multi-step form.

---

## 7. Zero-Typing UX Strategy

The product’s adoption depends on not adding friction to an already demanding job. “Zero typing” is achieved through two design decisions.

### 7.1 Saved shift templates

Facilities alone are not enough because users would still need to enter start and end times each time. Instead, Phylax stores combinations of:

- Facility
- Typical start time
- Typical end time
- Optional label, such as “Day” or “Night”

Example saved templates:

- Riverside Manor · Day 7–7
- Riverside Manor · Night 7–7
- St. Anne’s · 8-hour day
- Greenfield Rehab · Evening 3–11

### 7.2 Address autocomplete

The one-time setup step for facilities uses address autocomplete:

1. User types a partial facility name, such as “riversi.”
2. Phylax returns a matching facility/address.
3. User taps the match.
4. The facility is saved.

This keeps onboarding under approximately one minute without requiring the user to type a full address.

### 7.3 Date defaults

The date selector should favor the most common actions:

- Today — default
- Tomorrow — one-tap option
- Calendar — for less common dates

### 7.4 Optional notes

A notes field may exist for context such as unit, floor, or contact details, but it must be:

- Optional
- Collapsed by default
- Non-blocking
- Never required to save a shift

---

## 8. Onboarding Experience

The proposed onboarding sequence is:

1. Create an account.
2. Provide a phone number for SMS alerts.
3. Add three to five facilities using address autocomplete.
4. Create three to five saved shift templates from those facilities.
5. Log the first shift.

The experience should communicate the value before asking for significant setup. The user should understand that the setup creates reusable tiles that make future shift logging nearly instantaneous.

### 8.1 Important iOS/PWA decision

The product may be PWA-capable and installable to the home screen, but installation should not be a required onboarding gate.

Web push on iOS has installation-specific behavior, and requiring users to install the app would introduce friction into the core workflow. The revised strategy is:

- **SMS is the primary notification channel.**
- **Web push is optional** for users who install the PWA.
- **Email is optional** for low-urgency digests or future expansion.

This makes the critical alert path work across phone types and operating systems without depending on browser permissions or home-screen installation.

---

## 9. Conflict-Detection Engine

The conflict engine is the product’s central technical and customer-value component.

### 9.1 Inputs

Each shift record should include at least:

- User ID
- Staffing platform
- Facility ID
- Facility name
- Facility address or coordinates
- Local start date/time
- Local end date/time
- Time zone, if needed for robust handling
- Optional notes
- Status, such as active, cancelled, or completed
- Source/creation timestamp

### 9.2 Direct overlap detection

For a new shift `N` and an existing shift `E`, there is a direct conflict if their time intervals overlap.

Conceptually:

```text
conflict if N.start < E.end AND N.end > E.start
```

The implementation must decide how to handle boundary conditions. For example, a shift ending exactly when another begins may not be a direct overlap, but it may still fail the commute-buffer check if the facilities differ.

### 9.3 Midnight-crossing shifts

Overnight shifts must be represented as one continuous interval.

Example:

```text
Start: Day 1 at 7:00 p.m.
End:   Day 2 at 7:00 a.m.
```

The system must not treat this as two separate same-day fragments. The normalized end timestamp should fall on the following calendar day.

This is a critical correctness requirement because overnight healthcare shifts are a common pattern.

### 9.4 Commute-buffer detection

Two shifts may not overlap but can still be impossible to attend if the worker has insufficient time to travel between facilities.

For consecutive shifts at different facilities:

```text
available transition time = next.start - previous.end
conflict if available transition time < required buffer
```

The initial product can use a simple configurable buffer, but a stronger implementation should make the buffer explicit and explainable. Potential approaches include:

- A global default buffer, such as a conservative number of minutes
- A user-configurable minimum buffer
- A travel-time estimate plus a safety margin
- A future location-aware calculation

The initial scope should avoid turning this into a complex route-planning product. The first version can surface “insufficient buffer” as a warning rather than pretending to provide perfect traffic predictions.

### 9.5 Client-side instant feedback

The conflict check should run client-side against the already-loaded active shift list when the user saves a shift.

Benefits:

- Immediate feedback
- No network round trip before the warning appears
- The interface feels like it is actively watching the schedule
- Lower backend latency requirements for the core interaction

The backend should still validate the record on write to prevent inconsistent data when multiple sessions or devices are involved.

### 9.6 Conflict severity

A useful initial severity model is:

- **Critical:** Direct time overlap
- **High:** Travel buffer is impossible or extremely short
- **Warning:** Buffer is below the user’s preferred threshold
- **Informational:** Shift is close to another commitment but not currently conflicting

The MVP can launch with fewer levels, but the UI should distinguish “cannot attend both” from “risky transition.”

---

## 10. Cancellation-Policy Intelligence

The distinguishing alert detail is not merely “you have a conflict.” It should help the user decide what to do next.

### 10.1 Alert content

A conflict alert should include:

- The two conflicting shifts
- The staffing platforms involved
- The facilities and times
- The conflict type
- Which cancellation window applies
- The deadline or remaining time to cancel safely, where known
- A clear next action, such as “Review cancellation policy” or “Open shift details”

Example message:

> **Conflict detected:** Your CareRev shift at Riverside Manor overlaps with your ShiftMed shift at St. Anne’s. ShiftMed’s cancellation window closes in 3 hours. Review both commitments before cancelling.

### 10.2 Policy data model

The initial version can use a small static table of known platform cancellation policies. Each policy entry should support:

- Platform name
- Policy version or effective date
- Cancellation threshold
- Penalty description
- Source or verification note
- Last reviewed date
- Caveat that platform policies may vary by shift or location

### 10.3 Policy-risk caveat

Cancellation policies can change and may vary by contract, facility, worker status, or shift type. Phylax should avoid presenting policy information as a guarantee. The product should show a “verify current platform policy” link or disclaimer and provide a maintenance process for reviewing the table.

---

## 11. Notification Strategy

### 11.1 Primary channel: SMS

SMS is the critical notification rail because it:

- Works across major phone types and operating systems
- Does not require PWA installation
- Avoids browser push-permission loss
- Fits a familiar pattern such as appointment reminders or two-factor authentication
- Supports immediate conflict alerts and shift-approaching reminders

Twilio was identified as the likely delivery provider.

### 11.2 Optional web push

Web push may be offered as a bonus for users who install Phylax to their home screen. It should never be required for the core product promise.

### 11.3 Optional email

Email can support a low-urgency digest or summary, but it is not required for the MVP.

### 11.4 Notification events

Initial notification events could include:

- New shift creates a direct overlap
- New shift creates an insufficient travel buffer
- A conflict’s cancellation window is approaching
- A shift is approaching
- Daily or weekly upcoming-shift digest, optional

The MVP should avoid excessive reminders. Users must be able to configure frequency and quiet hours in a later iteration.

---

## 12. Proposed MVP Scope

### 12.1 Must-have features

- Account creation and authentication
- Phone-number capture and SMS consent
- Platform selection from a predefined list
- Facility creation with address autocomplete
- Saved shift templates
- Fast shift logging flow
- Today/Tomorrow/calendar date selection
- Midnight-aware shift intervals
- Active shift list
- Direct-overlap detection
- Basic commute-buffer warning
- Immediate client-side conflict feedback
- Backend validation on save
- Shift cancellation/removal
- SMS conflict alerts
- Basic platform cancellation-policy table
- Free-tier active-shift limit
- Paid subscription path at approximately $9/month or $79/year

### 12.2 Deliberately out of scope for the first release

- Scraping or syncing third-party staffing platforms
- Native iOS or Android apps
- Full calendar replacement
- Automated shift acceptance
- Job discovery or marketplace functionality
- Payroll and earnings tracking
- Traffic-aware turn-by-turn routing
- Complex workforce scheduling optimization
- Team, supervisor, or facility dashboards
- Email digest, unless implementation is trivial after the core loop works
- Web push as a dependency

---

## 13. Technical Architecture Direction

### 13.1 Frontend

Proposed stack:

- React
- Tailwind CSS
- GSAP for polished motion and interaction details
- PWA capabilities as an optional distribution/install layer

The interface should be mobile-first, thumb-friendly, and optimized for rapid use in a workday context.

### 13.2 Backend

Proposed backend:

- Supabase for authentication, database, and application backend services
- SMS provider such as Twilio
- A small policy-data store or table for platform cancellation rules

### 13.3 Suggested core entities

#### User

- `id`
- `phone_number`
- `phone_verified`
- `subscription_status`
- `notification_preferences`
- `created_at`

#### Platform

- `id`
- `name`
- `icon`
- `active`

#### Facility

- `id`
- `user_id`
- `name`
- `address`
- `latitude`
- `longitude`
- `created_at`

#### Shift template

- `id`
- `user_id`
- `facility_id`
- `label`
- `default_start_time`
- `default_end_time`
- `crosses_midnight`
- `created_at`

#### Shift

- `id`
- `user_id`
- `platform_id`
- `facility_id`
- `template_id`, nullable
- `start_at`
- `end_at`
- `status`
- `notes`, nullable
- `created_at`
- `updated_at`

#### Cancellation policy

- `id`
- `platform_id`
- `policy_text`
- `cancellation_window`
- `effective_from`, nullable
- `last_reviewed_at`
- `source_url`, nullable

#### Conflict

Conflicts may be computed dynamically at first. If persisted, a record could include:

- `id`
- `user_id`
- `new_shift_id`
- `existing_shift_id`
- `conflict_type`
- `severity`
- `resolved_at`, nullable
- `created_at`

### 13.4 Data integrity and privacy

Because the product stores worker schedules and phone numbers, it should include:

- Per-user row-level access controls
- Strict authentication checks
- Minimal data collection
- Clear SMS consent and opt-out handling
- Secure handling of phone numbers and location data
- Auditability for policy information
- A deletion/export path in a later privacy-hardening phase

Phylax does not need clinical data or patient information. The product should explicitly avoid collecting protected health information.

---

## 14. Screen-by-Screen Product Outline

### 14.1 Welcome / value screen

Purpose: Explain the product in one sentence and invite signup.

Key message:

> Keep every per-diem shift in one place and get warned before two staffing apps book you into the same time.

### 14.2 Account and phone setup

- Create account
- Enter phone number
- Explain why SMS is needed
- Obtain consent and verify number

### 14.3 Facility and template setup

- Add facility via autocomplete
- Select typical shift time
- Save as a reusable tile
- Repeat for three to five common facility/time combinations
- Allow later editing

### 14.4 Home / shift board

The home screen should show:

- Today’s shifts
- Upcoming shifts
- Conflict status
- A highly visible “Log shift” action
- Fast access to templates

### 14.5 Log-shift flow

Step 1: Platform icon grid  
Step 2: Saved template tiles  
Step 3: Date selector  
Step 4: Optional notes  
Step 5: Save and show immediate result

### 14.6 Conflict result

The result should be unmistakable and action-oriented:

- “Conflict detected” for an overlap
- “Tight travel window” for a buffer issue
- Show both shift cards
- Show platform cancellation windows
- Offer a clear route to review or remove a shift

### 14.7 Shift card actions

- View details
- Edit
- Cancel/remove
- See platform policy

### 14.8 Settings

- Facilities and templates
- Phone number and SMS consent
- Notification preferences
- Default commute buffer
- Subscription
- Account/data controls

---

## 15. Monetization Model

### 15.1 Proposed pricing

- **Free tier:** Limited number of active tracked shifts
- **Paid monthly:** Approximately $9/month
- **Paid annual:** Approximately $79/year

The annual price creates a modest discount while preserving a simple value proposition.

### 15.2 Upgrade trigger

The free tier should cap active tracked shifts at a point where a new user can understand the product but encounters the limitation when actively juggling multiple platforms.

The intended upgrade moment is:

> The user has real shifts across two or more platforms and needs to track more than the free tier permits.

### 15.3 Value framing

The subscription is positioned as cheaper than one avoidable:

- Cancellation penalty
- No-show
- Lost shift
- Platform access consequence

This is a strong outcome-based pricing frame, but it must be validated with real users rather than assumed.

### 15.4 Cost considerations

SMS costs should be monitored carefully. At realistic usage, the expected cost is small relative to a $9 subscription, but the product should still include:

- Rate limits
- Notification preferences
- Duplicate-alert prevention
- Monitoring for unusually high SMS volume

---

## 16. Seven-Day Build Feasibility

The concept is intentionally shaped around a short build window.

### Days 1–2: Core data and conflict engine

- Define schema
- Add authentication
- Implement shift, facility, template, and platform models
- Implement interval overlap logic
- Implement midnight-crossing normalization
- Implement basic commute-buffer checks

### Days 3–4: Core mobile workflow

- Build onboarding
- Build platform selection
- Build template selection
- Build date confirmation
- Build shift board and shift cards
- Add fast removal interaction

### Day 5: Alerts and policy data

- Add cancellation-policy table
- Integrate SMS provider
- Send conflict alerts
- Add upcoming-shift reminder foundation

### Day 6: Polish and edge cases

- Improve empty states and errors
- Test overnight shifts
- Test same-time and boundary-time cases
- Test duplicate saves
- Test facility changes and off-pattern shifts
- Add responsive and mobile interaction polish

### Day 7: Launch hardening

- Verify authentication and data isolation
- Verify SMS consent and opt-out
- Test subscription gating
- Validate production configuration
- Deploy the PWA-capable web app
- Run a small user test with target workers

The build is feasible only if the scope remains disciplined. Third-party platform integrations, sophisticated route prediction, and native apps would undermine the seven-day premise.

---

## 17. Principal Risks and Mitigations

| Risk | Why it matters | Mitigation |
|---|---|---|
| Manual entry is still too much friction | Users may abandon the tool | Make templates the default, use autocomplete, default date to Today, and make logging three taps in the common case |
| Conflict warnings are inaccurate | False positives erode trust; false negatives create real harm | Normalize times carefully, test overnight shifts, explain warning logic, and validate on the backend |
| Commute buffer is oversimplified | A fixed buffer may be too conservative or too permissive | Start with a transparent configurable buffer; add travel estimates only after validation |
| Cancellation policies change | Incorrect policy data could mislead users | Show last-reviewed dates, link to current policies, and use cautious wording |
| SMS costs or deliverability | Alerts are core to the promise | Use rate limits, consent, monitoring, retry handling, and user-configurable notifications |
| Users do not want another app | The product could be perceived as extra administrative work | Position it as a 15-second safety check and measure repeat usage after the first week |
| Competitors already exist but are hard to discover | The niche may not be as open as initial research suggests | Run direct customer interviews and targeted competitor searches before investing heavily |
| Platform-specific consequences vary | A generic alert may not support the right decision | Treat policy data as guidance, not a guarantee; collect user feedback on the decision needed |
| Healthcare trust expectations | Users may expect high reliability | Use careful language, visible timestamps, audit logs, and clear limitations |

---

## 18. Market Validation Plan

The concept should be validated with the target workforce before expanding the feature set.

### 18.1 Interview questions

- How many staffing apps do you actively use?
- How do you currently track accepted shifts across them?
- When was the last time two commitments conflicted?
- What did the conflict cost you?
- Do you manually check travel time between facilities?
- How quickly would you need a warning after accepting a shift?
- Would you enter a shift manually if the process took 15 seconds?
- Would saved facility/time templates make the process acceptable?
- Would SMS alerts be welcome or annoying?
- What would make a $9/month subscription worthwhile?

### 18.2 Prototype test

Test the three-tap workflow using a clickable prototype or low-fidelity build. Measure:

- Time to log a common shift
- Setup completion rate
- Error rate for dates and overnight times
- Whether users understand the conflict alert
- Whether the cancellation-policy detail changes their decision
- Whether users return to log a second and third shift

### 18.3 Paid validation

A meaningful test is not just whether users say the product is useful. Validate whether users will:

- Provide a phone number and SMS consent
- Complete template setup
- Log real shifts
- Keep using the product for several weeks
- Start a paid plan when the active-shift cap is reached

---

## 19. Key Metrics

### Activation

- Account creation rate
- Phone verification rate
- Percentage completing facility/template setup
- Time to first logged shift
- Percentage reaching a successful first conflict check

### Engagement

- Active users logging at least one shift per week
- Average active shifts per user
- Percentage using templates rather than manual entry
- Seven-day and thirty-day retention
- Number of shifts logged per active user

### Product quality

- Conflict detection accuracy
- False-positive reports
- False-negative reports
- SMS delivery rate
- Alert-to-action rate
- Average time from shift save to alert display

### Business

- Free-to-paid conversion
- Monthly recurring revenue
- Annual-plan adoption
- Churn
- SMS cost per active user
- Customer acquisition cost
- Lifetime value

The most important early signal is likely **repeat weekly logging**, not page views or signup volume.

---

## 20. Recommended Product Decisions to Lock Before Coding

The conversation already locks most of the product direction. The remaining decisions should be explicit:

1. **Initial commute-buffer policy** — fixed default versus user-configurable.
2. **Exact free-tier cap** — choose based on the typical number of concurrent shifts, not arbitrary storage limits.
3. **Policy disclaimer language** — ensure alerts do not imply legal or contractual certainty.
4. **SMS consent and opt-out flow** — make this compliant and understandable.
5. **Conflict resolution behavior** — decide whether saving a conflicting shift is allowed with a warning or blocked by default.
6. **Facility location source** — confirm the autocomplete/geocoding provider and its cost/terms.
7. **Time-zone handling** — especially for users traveling or facilities near time-zone boundaries.
8. **Duplicate shift behavior** — prevent accidental double-entry while allowing genuinely similar shifts.

A reasonable MVP default is to **allow the user to save a conflicting shift after an explicit warning**, because the system may not know which commitment is authoritative. Phylax should inform the decision, not silently delete or reject the user’s data.

---

## 21. Strategic Assessment

### Strengths

- Narrow, understandable problem
- Clear user and use case
- Strong urgency when a conflict occurs
- No dependency on private third-party APIs
- Fast common-case interaction
- Natural mobile use case
- Simple initial data model
- Clear subscription value proposition

### Weaknesses

- Manual entry creates an adoption hurdle
- Policy data requires ongoing maintenance
- Travel-buffer logic can become complex
- SMS is a recurring operating cost
- The audience may be difficult to reach through conventional indie-hacker channels
- Initial competitive research did not prove the category is empty

### Opportunity

The opportunity is not necessarily to build a broad healthcare scheduling platform. It is to own a very specific moment:

> A per-diem worker is about to accept or record another shift and needs to know whether that commitment collides with anything else.

If Phylax becomes trusted for that moment, adjacent features can be added carefully without weakening the core product.

### Threat

The biggest strategic threat is not a technically sophisticated competitor. It is abandonment caused by friction. If users must type too much, wait for alerts, or interpret complicated schedules, they will revert to calendars, notes, screenshots, or memory.

---

## 22. Recommended Roadmap After MVP

### Phase 1: Prove the core loop

- Fast template-based logging
- Accurate overlap detection
- Basic buffer warnings
- SMS conflict alerts
- Repeated weekly usage

### Phase 2: Improve decision support

- Better policy-source maintenance
- More precise warning severity
- User-defined commute buffers
- Conflict-resolution history
- Upcoming-shift reminders
- Optional email digest

### Phase 3: Reduce manual work without fragile scraping

Potential directions, subject to validation:

- Calendar import/export
- Share-sheet or email-forwarding capture
- Structured shift-confirmation parsing
- User-approved calendar synchronization
- Import from notifications or confirmations where technically and legally appropriate

These should be evaluated carefully. The original strategic advantage is avoiding a maintenance-heavy integration trap.

### Phase 4: Broader worker tools, only if demanded

Possible extensions include:

- Earnings visibility
- Facility notes
- Reliability history
- Shift-preparation checklists
- Personal availability rules

These are secondary. They should not be allowed to turn Phylax into a general-purpose workforce-management suite prematurely.

---

## 23. Final Concept Definition

**Phylax is a mobile-first cross-platform shift conflict guardrail for per-diem CNAs, LPNs, and RNs.** Users log accepted shifts from multiple staffing platforms using saved facility/time templates. Every new shift is checked immediately for direct overlap and insufficient travel time, including overnight shifts. When a conflict appears, Phylax explains the risk and surfaces the relevant cancellation-policy window. SMS is the primary alert channel; PWA installation and web push are optional.

The product’s success depends on three things:

1. **Near-zero friction** for the common logging case.
2. **Trustworthy conflict detection**, especially for midnight-crossing shifts and boundary times.
3. **Actionable alerts** that help users decide what to do before a penalty or no-show occurs.

The concept is appropriately narrow for a micro-SaaS MVP and technically realistic for a short initial build, provided it stays independent of third-party staffing-platform integrations and resists scope expansion.

---

## Source Notes from the Agent Conversation

The concept and decisions in this document were extracted from the supplied agent messages. The conversation referenced the following external materials for market/context claims:

- Roosevelt Institute — [Uber for Nursing](https://rooseveltinstitute.org/publications/uber-for-nursing/)
- LPE Project — [Nursing on Demand: The Gig Economy Comes for Health Care](https://lpeproject.org/blog/nursing-on-demand-the-gig-economy-comes-for-health-care/)
- Context — [Health workers turn to gig work](https://www.context.news/digital-rights/uber-for-nurses-us-health-workers-turn-to-gig-work)
- ByteIota — [Supabase security flaw affecting AI-generated apps](https://byteiota.com/supabase-security-flaw-170-apps-exposed-by-missing-rls/)
- Vibe App Scanner — [RLS misconfiguration vulnerability scanning](https://vibeappscanner.com/vulnerability/rls-misconfiguration)
- CAMAudit — [CAM audit software](https://www.camaudit.io/resources/cam-audits/cam-audit-software)

This document preserves the conversation’s product direction while clearly separating the **locked concept** from **recommended implementation and validation details** inferred from it.
