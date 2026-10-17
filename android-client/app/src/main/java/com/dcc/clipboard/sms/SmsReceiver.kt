package com.dcc.clipboard.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.util.Log
import com.dcc.clipboard.data.StorageHelper
import com.dcc.clipboard.report.SmsReportDispatcher
import java.util.concurrent.Executors

/**
 * SMS_RECEIVED entry point (PRD §5.1.1, REQ-202610-1264).
 *
 * The receiver decodes every PDU of the broadcast, concatenates multipart
 * messages, drops repeated deliveries and triggers the reporting layer.
 * Network I/O runs on a worker thread kept alive by [goAsync]; the foreground
 * service and retry queue from REQ-202610-1265 will take over long retries.
 */
class SmsReceiver : BroadcastReceiver() {

    @Suppress("DEPRECATION")
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) {
            return
        }
        val extras = intent.extras ?: run {
            Log.w(TAG, "sms.received_without_extras")
            return
        }
        val rawPdus = extras.get(EXTRA_PDUS) as? Array<*> ?: run {
            Log.w(TAG, "sms.received_without_pdus")
            return
        }
        val pdus = rawPdus.mapNotNull { it as? ByteArray }
        if (pdus.isEmpty()) {
            Log.w(TAG, "sms.received_empty_pdus")
            return
        }

        val format = extras.getString(EXTRA_FORMAT)
        val subscriptionId = intent.getIntExtra(EXTRA_SUBSCRIPTION, -1)
        val appContext = context.applicationContext
        val pendingResult = goAsync()
        WORKER.execute {
            try {
                handleBroadcast(appContext, pdus, format, subscriptionId)
            } catch (error: Throwable) {
                Log.e(TAG, "sms.handle_failed", error)
            } finally {
                pendingResult.finish()
            }
        }
    }

    private fun handleBroadcast(
        context: Context,
        pdus: List<ByteArray>,
        format: String?,
        subscriptionId: Int,
    ) {
        val segments = SmsMessageParser.parseSegments(pdus, format, subscriptionId)
        val message = SmsMessageAssembler.assemble(segments)
        if (message == null) {
            Log.w(TAG, "sms.parse_empty pdus=${pdus.size} format=${format ?: "default"}")
            return
        }
        if (message.body.isBlank()) {
            Log.w(TAG, "sms.empty_body sender=${SenderMask.mask(message.sender)}")
            return
        }

        val fingerprint = SmsFingerprint.of(message)
        Log.i(
            TAG,
            "sms.received sender=${SenderMask.mask(message.sender)}" +
                " segments=${message.segmentCount}" +
                " length=${message.body.length}" +
                " timestamp=${message.timestampMillis}" +
                " subscription=${message.subscriptionId}" +
                " fingerprint=${fingerprint.take(12)}",
        )

        val storage = StorageHelper(context)
        if (!storage.loadConfig().serviceEnabled) {
            Log.i(TAG, "sms.report_skipped reason=collection_disabled fingerprint=${fingerprint.take(12)}")
            return
        }

        if (deduplicator(context).isDuplicate(fingerprint)) {
            Log.i(TAG, "sms.duplicate_ignored fingerprint=${fingerprint.take(12)}")
            return
        }

        val result = SmsReportDispatcher.report(context, message, fingerprint)
        Log.i(
            TAG,
            "sms.report_queued success=${result.detail == "queued"}" +
                " fingerprint=${fingerprint.take(12)}" +
                " detail=${result.detail.take(80)}",
        )
    }

    companion object {
        private const val TAG = "DccSmsReceiver"
        private const val EXTRA_PDUS = "pdus"
        private const val EXTRA_FORMAT = "format"
        private const val EXTRA_SUBSCRIPTION = "subscription"

        private val WORKER = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "dcc-sms-receiver").apply { isDaemon = true }
        }

        // A single instance makes isDuplicate() process-wide atomic; separate
        // instances could both read "not seen" before either persists the key.
        private val DEDUP_LOCK = Any()

        @Volatile
        private var deduplicatorInstance: SmsDeduplicator? = null

        private fun deduplicator(context: Context): SmsDeduplicator =
            deduplicatorInstance ?: synchronized(DEDUP_LOCK) {
                deduplicatorInstance ?: SmsDeduplicator(
                    SharedPreferencesDedupStore(context),
                ).also { deduplicatorInstance = it }
            }
    }
}
