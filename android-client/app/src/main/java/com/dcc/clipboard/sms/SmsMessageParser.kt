package com.dcc.clipboard.sms

import android.util.Log

/**
 * Decodes the `pdus` extra of a SMS_RECEIVED broadcast (PRD §5.1.1).
 *
 * Every PDU is decoded independently; a malformed PDU is logged and skipped
 * so one bad segment cannot discard the rest of a multipart message.
 */
object SmsMessageParser {

    private const val TAG = "DccSmsParser"

    fun parseSegments(
        pdus: List<ByteArray>,
        format: String?,
        fallbackSubscriptionId: Int = -1,
        decoder: SmsPduDecoder = AndroidSmsPduDecoder,
    ): List<SmsSegment> {
        val segments = ArrayList<SmsSegment>(pdus.size)
        for (pdu in pdus) {
            val decoded = try {
                decoder.decode(pdu, format)
            } catch (error: Exception) {
                Log.w(TAG, "sms.pdu_parse_failed length=${pdu.size}", error)
                continue
            }
            segments.add(
                SmsSegment(
                    sender = decoded.sender,
                    body = decoded.body,
                    timestampMillis = decoded.timestampMillis,
                    subscriptionId = fallbackSubscriptionId,
                ),
            )
        }
        return segments
    }
}
