package com.dcc.clipboard.sms

import android.telephony.SmsMessage

/** Platform-independent result of decoding one PDU. */
data class DecodedPdu(
    val sender: String,
    val body: String,
    val timestampMillis: Long,
)

/** Seam that lets [SmsMessageParser] run against fakes on the JVM. */
fun interface SmsPduDecoder {
    fun decode(pdu: ByteArray, format: String?): DecodedPdu
}

/**
 * Real decoder backed by the Android telephony stack.
 *
 * `format` is `3gpp` for GSM/UMTS/LTE and `3gpp2` for CDMA. A null format is
 * allowed for senders that omit it and falls back to the legacy overload.
 */
object AndroidSmsPduDecoder : SmsPduDecoder {

    @Suppress("DEPRECATION")
    override fun decode(pdu: ByteArray, format: String?): DecodedPdu {
        val message = if (format.isNullOrBlank()) {
            SmsMessage.createFromPdu(pdu)
        } else {
            SmsMessage.createFromPdu(pdu, format)
        }
        return DecodedPdu(
            sender = message.displayOriginatingAddress
                ?: message.originatingAddress
                ?: "",
            body = message.displayMessageBody ?: message.messageBody ?: "",
            timestampMillis = message.timestampMillis.takeIf { it > 0 }
                ?: System.currentTimeMillis(),
        )
    }
}
