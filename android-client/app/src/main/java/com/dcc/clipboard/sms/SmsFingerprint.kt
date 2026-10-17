package com.dcc.clipboard.sms

import java.security.MessageDigest

/**
 * Stable identity for a logical SMS, used to drop duplicate SMS_RECEIVED
 * broadcasts (some OEM ROMs deliver the same broadcast twice).
 */
object SmsFingerprint {

    fun of(message: AssembledSms): String {
        val material = buildString {
            append(message.sender)
            append('\u0000')
            append(message.body)
            append('\u0000')
            append(message.timestampMillis)
            append('\u0000')
            append(message.subscriptionId)
        }
        return sha256Hex(material.toByteArray(Charsets.UTF_8))
    }

    private fun sha256Hex(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        return digest.joinToString(separator = "") { "%02x".format(it) }
    }
}
