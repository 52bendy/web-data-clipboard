package com.dcc.clipboard.report

import android.content.Context
import android.util.Log
import com.dcc.clipboard.data.StorageHelper
import com.dcc.clipboard.sms.AssembledSms

/**
 * Reporting seam between [com.dcc.clipboard.sms.SmsReceiver] and the network
 * layer. REQ-202610-1265 can replace [SmsApiClient] with a queue/backoff
 * implementation without touching PDU parsing or deduplication.
 */
object SmsReportDispatcher {

    private const val TAG = "DccSmsReport"

    fun report(context: Context, message: AssembledSms, fingerprint: String): UploadResult {
        val storage = StorageHelper(context)
        val config = storage.loadConfig()
        if (com.dcc.clipboard.data.ConfigValidator.validate(
                config.serverUrl,
                config.apiToken,
                config.deviceName,
            ).isValid.not()
        ) {
            Log.w(TAG, "sms.report_skipped reason=not_configured fingerprint=${fingerprint.take(12)}")
            return UploadResult(false, 0, "configuration incomplete")
        }

        val payload = SmsPayload(
            deviceId = storage.getOrCreateDeviceId(),
            deviceName = config.deviceName,
            sender = message.sender,
            rawContent = message.body,
            timestamp = message.timestampMillis,
            clientMessageId = fingerprint,
        )
        Log.i(
            TAG,
            "sms.report_triggered device=${config.deviceName}" +
                " fingerprint=${fingerprint.take(12)}" +
                " length=${message.body.length}",
        )

        val result = SmsApiClient(storage).upload(payload)
        if (!result.success) {
            PendingReportStore(context).enqueue(payload)
            Log.w(
                TAG,
                "sms.report_queued fingerprint=${fingerprint.take(12)}" +
                    " status=${result.statusCode}",
            )
        }
        return result
    }
}
