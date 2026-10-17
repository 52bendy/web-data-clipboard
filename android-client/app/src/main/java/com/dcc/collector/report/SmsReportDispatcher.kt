package com.dcc.collector.report

import android.content.Context
import android.util.Log
import com.dcc.collector.config.StorageHelper
import com.dcc.collector.sms.AssembledSms

/**
 * Reporting seam between [com.dcc.collector.sms.SmsReceiver] and the network
 * layer. REQ-202610-1265 can replace [SmsApiClient] with a queue/backoff
 * implementation without touching PDU parsing or deduplication.
 */
object SmsReportDispatcher {

    private const val TAG = "DccSmsReport"

    fun report(context: Context, message: AssembledSms, fingerprint: String): UploadResult {
        val storage = StorageHelper(context)
        if (!storage.isConfigured) {
            Log.w(TAG, "sms.report_skipped reason=not_configured fingerprint=${fingerprint.take(12)}")
            return UploadResult(false, 0, "configuration incomplete")
        }

        val payload = SmsPayload(
            deviceId = storage.deviceId,
            deviceName = storage.deviceName,
            sender = message.sender,
            rawContent = message.body,
            timestamp = message.timestampMillis,
            clientMessageId = fingerprint,
        )
        Log.i(
            TAG,
            "sms.report_triggered device=${storage.deviceName}" +
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
