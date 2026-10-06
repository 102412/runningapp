# API reference

> **Generated** from `docs/openapi.json` by `pnpm openapi`. Do not edit by hand.
> The machine-readable contract is [`docs/openapi.json`](./openapi.json); conventions (auth,
> errors, pagination, idempotency) are in [`API.md`](./API.md).

Version **0.1.0**. Every path is under `/v1`. **Auth** column:
`public` = no token, `optional` = works anonymously (a presented token must still be valid),
`bearer` = signed-in user, `staff` = moderator/admin only.

## Auth

| Method | Path | Operation | Auth | What it does | Errors |
|---|---|---|---|---|---|
| POST | `/v1/auth/signup` | `signup` | public | Create an account and sign in | 403 409 422 429 |
| POST | `/v1/auth/login` | `login` | public | Sign in with email and password | 401 403 422 429 |
| POST | `/v1/auth/refresh` | `refreshTokens` | public | Exchange a refresh token for a new token pair | 401 403 422 429 |
| POST | `/v1/auth/logout` | `logout` | bearer | Revoke the current session | 401 |
| POST | `/v1/auth/logout-all` | `logoutAll` | bearer | Revoke every session on every device | 401 |
| POST | `/v1/auth/verify-email` | `verifyEmail` | public | Confirm an email address with the emailed token | 410 422 429 |
| POST | `/v1/auth/verify-email/resend` | `resendVerificationEmail` | bearer | Send a new verification email (max one per minute) | 401 429 |
| POST | `/v1/auth/password/forgot` | `forgotPassword` | public | Request a password-reset email | 422 429 |
| POST | `/v1/auth/password/reset` | `resetPassword` | public | Set a new password using the emailed token | 410 422 429 |
| POST | `/v1/auth/password/change` | `changePassword` | bearer | Change password (signs out all other sessions) | 401 422 429 |
| GET | `/v1/auth/sessions` | `listSessions` | bearer | List active sessions (devices) for the account | 401 |
| DELETE | `/v1/auth/sessions/{sessionId}` | `revokeSession` | bearer | Sign out one specific session | 401 404 |
| GET | `/v1/auth/username-available` | `checkUsernameAvailability` | public | Check whether a username can be registered | 422 429 |

## Me

| Method | Path | Operation | Auth | What it does | Errors |
|---|---|---|---|---|---|
| POST | `/v1/me/account/deletion` | `requestAccountDeletion` | bearer | Schedule account deletion (re-authenticates with password) | 401 422 429 |
| DELETE | `/v1/me/account/deletion` | `cancelAccountDeletion` | bearer | Cancel a scheduled account deletion | 401 409 |
| GET | `/v1/me` | `getMe` | bearer | The signed-in account: identity, profile, settings, deletion state | 401 |
| PATCH | `/v1/me/profile` | `updateProfile` | bearer | Update display name, bio, username, location label, primary sport | 401 409 422 429 |
| PUT | `/v1/me/avatar` | `setAvatar` | bearer | Use a READY avatar image as your profile picture | 401 404 422 429 |
| DELETE | `/v1/me/avatar` | `removeAvatar` | bearer | Remove your profile picture | 401 |
| GET | `/v1/me/settings` | `getSettings` | bearer | Privacy and preference settings | 401 |
| PATCH | `/v1/me/settings` | `updateSettings` | bearer | Update privacy and preference settings (partial) | 401 403 422 429 |
| GET | `/v1/me/sports` | `getSportPreferences` | bearer | Your explicit sport interests (used for onboarding and ranking) | 401 |
| PUT | `/v1/me/sports` | `setSportPreferences` | bearer | Replace your sport interests | 401 422 |
| GET | `/v1/me/privacy-zones` | `listPrivacyZones` | bearer | Your privacy zones (home, school...) | 401 |
| POST | `/v1/me/privacy-zones` | `createPrivacyZone` | bearer | Hide everything near a place from other viewers (max 10 zones) | 401 422 429 |
| DELETE | `/v1/me/privacy-zones/{id}` | `deletePrivacyZone` | bearer | Remove a privacy zone | 401 |
| GET | `/v1/me/integrations` | `listIntegrations` | bearer | Third-party activity sources and their availability | 401 |
| DELETE | `/v1/me/integrations/{provider}` | `disconnectIntegration` | bearer | Disconnect an integration | 401 422 |
| GET | `/v1/me/exports` | `listDataExports` | bearer | Your recent data exports | 401 |
| POST | `/v1/me/exports` | `requestDataExport` | bearer | Request a download of all your data | 401 422 429 |
| GET | `/v1/me/exports/{id}` | `getDataExport` | bearer | Status of an export; a fresh short-lived download link once READY | 401 404 |

## Users

| Method | Path | Operation | Auth | What it does | Errors |
|---|---|---|---|---|---|
| GET | `/v1/users/{userId}` | `getUser` | optional | A user profile as seen by the caller | 401 404 429 |
| GET | `/v1/users/by-username/{username}` | `getUserByUsername` | optional | A user profile by @username (case-insensitive) | 401 404 422 429 |

## Social

| Method | Path | Operation | Auth | What it does | Errors |
|---|---|---|---|---|---|
| POST | `/v1/users/{userId}/follow` | `followUser` | bearer | Follow a user (or request to follow a private account) | 401 404 422 429 |
| DELETE | `/v1/users/{userId}/follow` | `unfollowUser` | bearer | Unfollow, or withdraw a pending follow request | 401 429 |
| DELETE | `/v1/me/followers/{userId}` | `removeFollower` | bearer | Remove one of your followers | 401 |
| GET | `/v1/users/{userId}/followers` | `listFollowers` | bearer | Followers of a user (private accounts: followers only) | 400 401 403 404 |
| GET | `/v1/users/{userId}/following` | `listFollowing` | bearer | Accounts a user follows (private accounts: followers only) | 400 401 403 404 |
| GET | `/v1/me/follow-requests` | `listFollowRequests` | bearer | Pending follow requests awaiting your approval | 400 401 |
| POST | `/v1/me/follow-requests/{requestId}/accept` | `acceptFollowRequest` | bearer | Approve a follow request | 401 404 429 |
| POST | `/v1/me/follow-requests/{requestId}/reject` | `rejectFollowRequest` | bearer | Decline a follow request (the requester is not notified) | 401 404 429 |
| PUT | `/v1/users/{userId}/block` | `blockUser` | bearer | Block a user | 401 404 422 429 |
| DELETE | `/v1/users/{userId}/block` | `unblockUser` | bearer | Unblock a user (does not restore follows) | 401 |
| GET | `/v1/me/blocks` | `listBlockedUsers` | bearer | Users you have blocked | 400 401 |

## Sports

| Method | Path | Operation | Auth | What it does | Errors |
|---|---|---|---|---|---|
| GET | `/v1/sports` | `listSports` | public | Supported sports and which metrics each one supports |  |

## Activities

| Method | Path | Operation | Auth | What it does | Errors |
|---|---|---|---|---|---|
| POST | `/v1/activities` | `createActivity` | bearer | Log an activity (the LOG step) | 401 403 409 422 429 |
| POST | `/v1/activities/import/gpx` | `importGpxActivity` | bearer | Import a GPX file as an activity | 401 413 415 422 429 |
| GET | `/v1/activities/{id}` | `getActivity` | optional | One activity, with splits | 401 404 429 |
| PATCH | `/v1/activities/{id}` | `updateActivity` | bearer | Edit title, description, visibility, route privacy | 401 403 404 422 429 |
| DELETE | `/v1/activities/{id}` | `deleteActivity` | bearer | Delete an activity (and its route and auto-generated feed post) | 401 404 |
| GET | `/v1/activities/{id}/route` | `getActivityRoute` | optional | The activity route as encoded polyline segments | 401 404 429 |
| GET | `/v1/users/{userId}/activities` | `listUserActivities` | optional | A user's activities visible to the caller, newest first | 400 401 429 |

## Media

| Method | Path | Operation | Auth | What it does | Errors |
|---|---|---|---|---|---|
| GET | `/v1/media/limits` | `getMediaLimits` | bearer | Upload limits and accepted formats (validate client-side before uploading) | 401 |
| POST | `/v1/media/uploads` | `initMediaUpload` | bearer | Start an upload and get a presigned URL (step 1 of 3) | 401 413 422 429 |
| POST | `/v1/media/{id}/complete` | `completeMediaUpload` | bearer | Confirm the file was uploaded and start processing (step 3 of 3) | 401 404 422 429 |
| GET | `/v1/media/{id}` | `getMedia` | bearer | Status and URLs of your own media (poll while PROCESSING) | 401 404 |
| DELETE | `/v1/media/{id}` | `deleteMedia` | bearer | Delete your media (refused while attached to a post) | 401 404 409 |
| POST | `/v1/media/{id}/retry` | `retryMediaProcessing` | bearer | Retry processing of media that FAILED with PROCESSING_ERROR | 401 404 409 429 |

## Posts

| Method | Path | Operation | Auth | What it does | Errors |
|---|---|---|---|---|---|
| POST | `/v1/posts` | `createPost` | bearer | Share something (the SHOW step): caption, activity, photos/videos, sponsorship | 401 403 404 409 422 429 |
| GET | `/v1/posts/{id}` | `getPost` | optional | One post as seen by the caller | 401 404 429 |
| PATCH | `/v1/posts/{id}` | `updatePost` | bearer | Edit caption, audience, comment permission, topics or sponsorship | 401 403 404 409 422 429 |
| DELETE | `/v1/posts/{id}` | `deletePost` | bearer | Delete a post (and its media). It disappears for everyone immediately. | 401 404 |
| POST | `/v1/posts/{id}/publish` | `publishPost` | bearer | Publish a DRAFT or retry a PUBLISH_FAILED post | 401 403 404 422 429 |
| POST | `/v1/posts/{id}/media` | `attachPostMedia` | bearer | Add media to an existing post (e.g. add a video to an activity post) | 401 403 404 409 422 429 |
| DELETE | `/v1/posts/{id}/media/{mediaId}` | `detachPostMedia` | bearer | Remove one media item from a post (it stays in your media library) | 401 404 422 |
| GET | `/v1/me/posts` | `listMyPosts` | bearer | Your own posts in every state (drafts, pending media, failed, moderated) | 400 401 |
| GET | `/v1/users/{userId}/posts` | `listUserPosts` | optional | A user's published posts the caller may see (profile grid), newest first | 400 401 403 404 429 |

## Engagement

| Method | Path | Operation | Auth | What it does | Errors |
|---|---|---|---|---|---|
| PUT | `/v1/posts/{id}/reaction` | `reactToPost` | bearer | React to a post (idempotent; sending another type changes your reaction) | 401 404 422 429 |
| DELETE | `/v1/posts/{id}/reaction` | `unreactToPost` | bearer | Remove your reaction (idempotent) | 401 429 |
| GET | `/v1/posts/{id}/reactions` | `listPostReactions` | bearer | Who reacted (excludes people you have blocked or who blocked you) | 400 401 404 |
| PUT | `/v1/posts/{id}/bookmark` | `bookmarkPost` | bearer | Save a post (private to you) | 401 404 429 |
| DELETE | `/v1/posts/{id}/bookmark` | `unbookmarkPost` | bearer | Remove a saved post (idempotent) | 401 429 |
| GET | `/v1/me/bookmarks` | `listBookmarks` | bearer | Your saved posts, most recently saved first (posts you can no longer see are omitted) | 400 401 |
| POST | `/v1/posts/{id}/shares` | `recordShare` | bearer | Record that you shared a post (copy link, system share sheet...) | 401 404 422 429 |
| GET | `/v1/posts/{id}/comments` | `listComments` | optional | Top-level comments on a post (replies via /comments/{id}/replies) | 400 401 404 429 |
| POST | `/v1/posts/{id}/comments` | `createComment` | bearer | Comment on a post, or reply to a comment | 401 403 404 409 422 429 |
| GET | `/v1/comments/{commentId}/replies` | `listReplies` | optional | Replies to a top-level comment, oldest first | 400 401 404 429 |
| DELETE | `/v1/comments/{commentId}` | `deleteComment` | bearer | Delete a comment (and its replies). Allowed for the comment author and the post author. | 401 403 404 |
| PUT | `/v1/comments/{commentId}/reaction` | `likeComment` | bearer | Like a comment (idempotent) | 401 404 429 |
| DELETE | `/v1/comments/{commentId}/reaction` | `unlikeComment` | bearer | Remove your like from a comment (idempotent) | 401 429 |

## Notifications

| Method | Path | Operation | Auth | What it does | Errors |
|---|---|---|---|---|---|
| GET | `/v1/notifications` | `listNotifications` | bearer | Your notifications, newest first | 400 401 422 |
| GET | `/v1/notifications/unread-count` | `getUnreadNotificationCount` | bearer | Badge count (capped at 100) | 401 |
| POST | `/v1/notifications/read` | `markNotificationsRead` | bearer | Mark notifications read: specific ids, or `all: true` | 401 422 429 |
| GET | `/v1/me/notification-preferences` | `getNotificationPreferences` | bearer | Which notification types you receive in-app and as push | 401 |
| PUT | `/v1/me/notification-preferences` | `updateNotificationPreferences` | bearer | Update preferences for the given types (others unchanged) | 401 422 429 |
| PUT | `/v1/me/device/push-token` | `registerPushToken` | bearer | Register this device's push token (APNs/FCM/Expo) | 401 422 429 |
| DELETE | `/v1/me/device/push-token` | `removePushToken` | bearer | Stop push notifications on this device | 401 |

## Feed

| Method | Path | Operation | Auth | What it does | Errors |
|---|---|---|---|---|---|
| GET | `/v1/feed/following` | `getFollowingFeed` | bearer | Chronological feed: posts from people you follow, plus your own | 400 401 429 |
| GET | `/v1/feed/home` | `getHomeFeed` | bearer | Ranked home feed: people you follow, mixed with discovery | 400 401 410 429 |
| GET | `/v1/feed/explore` | `getExploreFeed` | bearer | Discovery feed: public posts from people you do not follow | 400 401 410 429 |

## Events

| Method | Path | Operation | Auth | What it does | Errors |
|---|---|---|---|---|---|
| POST | `/v1/events` | `recordEvents` | bearer | Report what the user saw and did (impressions, watch time, "not interested"...) | 400 401 422 429 |

## Search

| Method | Path | Operation | Auth | What it does | Errors |
|---|---|---|---|---|---|
| GET | `/v1/search` | `search` | bearer | Search overview: the top few users, topics and posts | 400 401 422 429 |
| GET | `/v1/search/users` | `searchUsers` | bearer | Find people by username or name (exact and prefix matches rank first) | 400 401 422 429 |
| GET | `/v1/search/posts` | `searchPosts` | bearer | Find posts by caption text or topic | 400 401 422 429 |
| GET | `/v1/search/topics` | `searchTopics` | bearer | Find topics (hashtags) that public posts use | 400 401 422 429 |

## Discover

| Method | Path | Operation | Auth | What it does | Errors |
|---|---|---|---|---|---|
| GET | `/v1/discover/athletes` | `suggestAthletes` | bearer | Who to follow | 400 401 429 |
| GET | `/v1/discover/topics` | `listTrendingTopics` | optional | Trending topics (last 7 days, used by at least two different people) | 400 401 429 |
| GET | `/v1/topics/{slug}` | `getTopic` | optional | A topic and how many public posts use it | 401 404 429 |
| GET | `/v1/topics/{slug}/posts` | `listTopicPosts` | optional | Posts using a topic, newest first | 400 401 404 429 |

## Creators

| Method | Path | Operation | Auth | What it does | Errors |
|---|---|---|---|---|---|
| GET | `/v1/me/creator` | `getMyCreatorProfile` | bearer | Your creator/professional profile, if you have one | 401 |
| PUT | `/v1/me/creator` | `upsertCreatorProfile` | bearer | Become (or update) a creator: athlete, coach, brand, club... | 401 422 429 |
| DELETE | `/v1/me/creator` | `deleteCreatorProfile` | bearer | Remove your creator profile | 401 |
| POST | `/v1/me/creator/verification-request` | `requestCreatorVerification` | bearer | Ask staff to verify your creator account | 401 409 429 |
| GET | `/v1/me/creator/partnerships` | `listBrandPartnerships` | bearer | Your brand partnerships (reference them from sponsored posts) | 400 401 |
| POST | `/v1/me/creator/partnerships` | `createBrandPartnership` | bearer | Record a brand partnership | 401 409 422 429 |
| DELETE | `/v1/me/creator/partnerships/{id}` | `deleteBrandPartnership` | bearer | Delete a brand partnership (existing disclosures keep their brand name) | 401 |

## Moderation

| Method | Path | Operation | Auth | What it does | Errors |
|---|---|---|---|---|---|
| POST | `/v1/reports` | `createReport` | bearer | Report a post, comment or user | 401 403 404 409 422 429 |
| GET | `/v1/me/reports` | `listMyReports` | bearer | Reports you filed (status only) | 400 401 |

## Admin

| Method | Path | Operation | Auth | What it does | Errors |
|---|---|---|---|---|---|
| GET | `/v1/admin/reports` | `adminListReports` | staff | Moderation queue, oldest first | 400 401 403 |
| GET | `/v1/admin/reports/{id}` | `adminGetReport` | staff | One report with the reported content and the audit trail for the target | 401 403 404 |
| POST | `/v1/admin/reports/{id}/resolve` | `adminResolveReport` | staff | Act on a report (hide, remove, warn, suspend) or dismiss it | 401 403 404 409 422 |
| GET | `/v1/admin/moderation/actions` | `adminListActions` | staff | The moderation audit trail, newest first | 400 401 403 |
| POST | `/v1/admin/moderation/actions` | `adminTakeAction` | staff | Take a moderation action without a report (restore, unsuspend, verify creators...) | 401 403 404 409 422 |

## Dev

| Method | Path | Operation | Auth | What it does | Errors |
|---|---|---|---|---|---|
| PUT | `/v1/storage/upload` | `devLocalUpload` | public | DEV ONLY (local storage driver): signed upload target | 403 429 |
| GET | `/v1/storage/files/{*}` | `devLocalFile` | public | DEV ONLY (local storage driver): signed file download | 403 404 416 429 |
| GET | `/v1/dev/outbox` | `devListOutbox` | public | DEV ONLY: emails captured by the console mailer (includes raw verification/reset tokens) | 422 |

## Error codes

Every error is `{ "error": { "code", "message", "requestId", "details?" } }`. Branch on `code`, never on `message`.

| HTTP | Code | Default message |
|---|---|---|
| 400 | `BAD_REQUEST` | The request was malformed. |
| 400 | `INVALID_CURSOR` | The pagination cursor is invalid or expired. |
| 400 | `MALFORMED_JSON` | The request body is not valid JSON. |
| 401 | `INVALID_CREDENTIALS` | Email or password is incorrect. |
| 401 | `REFRESH_TOKEN_INVALID` | The refresh token is invalid or expired. |
| 401 | `REFRESH_TOKEN_REUSED` | The refresh token was already used. The session has been revoked; sign in again. |
| 401 | `SESSION_REVOKED` | This session is no longer active. |
| 401 | `TOKEN_EXPIRED` | The access token has expired. Refresh it. |
| 401 | `TOKEN_INVALID` | The access token is invalid. |
| 401 | `UNAUTHENTICATED` | Authentication is required. |
| 403 | `ACCOUNT_PENDING_DELETION` | This account is scheduled for deletion. |
| 403 | `ACCOUNT_PRIVATE` | This account is private. |
| 403 | `ACCOUNT_SUSPENDED` | This account is suspended. |
| 403 | `COMMENTS_RESTRICTED` | Comments are restricted on this post. |
| 403 | `EMAIL_NOT_VERIFIED` | Verify your email address to do that. |
| 403 | `FORBIDDEN` | You are not allowed to do that. |
| 403 | `INSUFFICIENT_ROLE` | Your role does not permit this action. |
| 403 | `PUBLIC_ACCOUNT_NOT_ALLOWED` | Public accounts are not available for your age. |
| 403 | `UNDER_MINIMUM_AGE` | You do not meet the minimum age to sign up. |
| 404 | `ACTIVITY_NOT_FOUND` | Activity not found. |
| 404 | `COMMENT_NOT_FOUND` | Comment not found. |
| 404 | `FOLLOW_REQUEST_NOT_FOUND` | Follow request not found. |
| 404 | `MEDIA_NOT_FOUND` | Media not found. |
| 404 | `NOT_FOUND` | Resource not found. |
| 404 | `NOTIFICATION_NOT_FOUND` | Notification not found. |
| 404 | `POST_NOT_FOUND` | Post not found. |
| 404 | `REPORT_NOT_FOUND` | Report not found. |
| 404 | `SESSION_NOT_FOUND` | Session not found. |
| 404 | `SPORT_NOT_FOUND` | Sport not found. |
| 404 | `TOPIC_NOT_FOUND` | Topic not found. |
| 404 | `USER_NOT_FOUND` | User not found. |
| 409 | `ALREADY_REPORTED` | You already reported this. |
| 409 | `EMAIL_TAKEN` | An account with this email already exists. |
| 409 | `IDEMPOTENCY_IN_PROGRESS` | A request with this Idempotency-Key is still being processed. |
| 409 | `IDEMPOTENCY_KEY_REUSED` | This Idempotency-Key was used with a different request. |
| 409 | `INVALID_STATE` | The resource is not in a state that allows this. |
| 409 | `MEDIA_ALREADY_ATTACHED` | This media is already attached to a post. |
| 409 | `USERNAME_CHANGE_COOLDOWN` | You changed your username recently. Try again later. |
| 409 | `USERNAME_TAKEN` | This username is taken. |
| 410 | `FEED_EXPIRED` | This feed page has expired. Refresh the feed from the top. |
| 410 | `TOKEN_CONSUMED_OR_EXPIRED` | This link has expired or was already used. |
| 413 | `PAYLOAD_TOO_LARGE` | The request body is too large. |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Unsupported content type. |
| 422 | `CONTENT_REJECTED` | This content was not accepted. |
| 422 | `EMPTY_POST` | A post needs a caption, an activity or media. |
| 422 | `MEDIA_NOT_READY` | The media is not ready. |
| 422 | `MEDIA_REJECTED` | The media was rejected and cannot be used. |
| 422 | `METRIC_NOT_SUPPORTED_FOR_SPORT` | A provided metric is not supported for this sport. |
| 422 | `PASSWORD_INCORRECT` | The current password is incorrect. |
| 422 | `PASSWORD_TOO_WEAK` | The password does not meet requirements. |
| 422 | `SELF_ACTION_NOT_ALLOWED` | You cannot do that to yourself. |
| 422 | `UNSUPPORTED_FILE` | The file type is not supported. |
| 422 | `UPLOAD_INCOMPLETE` | The uploaded file is missing or the wrong size. |
| 422 | `VALIDATION_FAILED` | The request failed validation. |
| 429 | `RATE_LIMITED` | Too many requests. Slow down. |
| 500 | `INTERNAL` | Something went wrong on our side. |
| 501 | `INTEGRATION_NOT_CONFIGURED` | This integration is not configured on this server. |
| 501 | `NOT_IMPLEMENTED` | This is not implemented. |
| 503 | `SERVICE_UNAVAILABLE` | The service is temporarily unavailable. |
