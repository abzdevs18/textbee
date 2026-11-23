export const ApiEndpoints = {
  auth: {
    login: () => '/auth/login',
    register: () => '/auth/register',
    signInWithGoogle: () => '/auth/google-login',
    updateProfile: () => '/auth/update-profile',
    changePassword: () => '/auth/change-password',

    whoAmI: () => '/auth/who-am-i',
    updateOnboarding: () => '/auth/onboarding',

    sendEmailVerificationEmail: () => '/auth/send-email-verification-email',
    verifyEmail: () => '/auth/verify-email',

    requestPasswordReset: () => '/auth/request-password-reset',
    resetPassword: () => '/auth/reset-password',

    generateApiKey: () => '/auth/api-keys',
    listApiKeys: (status?: 'active' | 'revoked' | 'all') =>
      status
        ? `/auth/api-keys?status=${encodeURIComponent(status)}`
        : '/auth/api-keys',
    revokeApiKey: (id: string) => `/auth/api-keys/${id}/revoke`,
    renameApiKey: (id: string) => `/auth/api-keys/${id}/rename`,
    deleteApiKey: (id: string) => `/auth/api-keys/${id}`,
  },
  gateway: {
    listDevices: () => '/gateway/devices',
    updateDevice: (id: string) => `/gateway/devices/${id}`,
    assignDeviceTenant: (id: string) => `/gateway/devices/${id}/assignment`,
    deleteDevice: (id: string) => `/gateway/devices/${id}`,
    sendSMS: (id: string) => `/gateway/devices/${id}/send-sms`,
    sendBulkSMS: (id: string) => `/gateway/devices/${id}/send-bulk-sms`,
    getReceivedSMS: (id: string) => `/gateway/devices/${id}/get-received-sms`,
    getMessages: (id: string) => `/gateway/devices/${id}/messages`,
    remoteScreenSession: (id: string, sessionId?: string) =>
      sessionId
        ? `/gateway/devices/${id}/remote-screen/session?sessionId=${sessionId}`
        : `/gateway/devices/${id}/remote-screen/session`,
    remoteScreen: (id: string, since?: number, statusAt?: number) => {
      // wait=1: the API holds the request until a new frame/status exists.
      const params = new URLSearchParams({ wait: '1' })
      if (since) params.set('since', String(since))
      if (statusAt) params.set('statusAt', String(statusAt))
      return `/gateway/devices/${id}/remote-screen?${params}`
    },
    remoteScreenInput: (id: string) =>
      `/gateway/devices/${id}/remote-screen/input`,
    remoteCameraSession: (id: string, sessionId?: string) =>
      sessionId
        ? `/gateway/devices/${id}/remote-camera/session?sessionId=${sessionId}`
        : `/gateway/devices/${id}/remote-camera/session`,
    remoteCamera: (
      id: string,
      opts: { since?: number; statusAt?: number; wait?: boolean } = {},
    ) => {
      const params = new URLSearchParams()
      if (opts.wait) params.set('wait', '1')
      if (opts.since) params.set('since', String(opts.since))
      if (opts.statusAt) params.set('statusAt', String(opts.statusAt))
      const query = params.toString()
      return `/gateway/devices/${id}/remote-camera${query ? `?${query}` : ''}`
    },
    remoteCameraInput: (id: string) =>
      `/gateway/devices/${id}/remote-camera/input`,
    /** Relative to the API base URL; an <img> plays it directly. */
    remoteCameraStream: (id: string, token: string, attempt = 0) =>
      `/gateway/devices/${id}/remote-camera/stream?token=${encodeURIComponent(token)}&r=${attempt}`,
    listAccountMessages: () => '/gateway/messages',
    resendMessages: () => '/gateway/messages/resend',
    cancelMessage: (smsId: string) => `/gateway/messages/${smsId}/cancel`,
    rerouteMessage: (smsId: string) => `/gateway/messages/${smsId}/reroute`,
    deleteMessage: (smsId: string) => `/gateway/messages/${smsId}`,
    deleteMessages: () => '/gateway/messages/delete',
    deleteMatchingMessages: () => '/gateway/messages',

    getWebhooks: () => '/webhooks',
    getWebhookNotifications: () => '/webhooks/notifications',
    createWebhook: () => '/webhooks',
    updateWebhook: (id: string) => `/webhooks/${id}`,
    deleteWebhook: (id: string) => `/webhooks/${id}`,
    getStats: () => '/gateway/stats',
  },
  billing: {
    currentSubscription: () => '/billing/current-subscription',
    checkout: () => '/billing/checkout',
    changePlan: () => '/billing/change-plan',
    plans: () => '/billing/plans',
  },
  support: {
    customerSupport: () => '/support/customer-support',
    requestAccountDeletion: () => '/support/request-account-deletion',
  },
}
