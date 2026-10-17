package com.dcc.clipboard.data

import java.net.URI
import java.net.URISyntaxException

enum class ConfigField {
    SERVER_URL,
    API_TOKEN,
    DEVICE_NAME,
}

enum class ConfigError {
    SERVER_URL_EMPTY,
    SERVER_URL_INVALID,
    API_TOKEN_EMPTY,
    API_TOKEN_TOO_LONG,
    DEVICE_NAME_EMPTY,
    DEVICE_NAME_TOO_LONG,
}

data class ValidationResult(
    val normalizedServerUrl: String?,
    val errors: Map<ConfigField, ConfigError>,
) {
    val isValid: Boolean
        get() = errors.isEmpty()
}

/**
 * Pure validation/normalization of the connection form. Kept free of Android types so the
 * rules can be covered by fast JVM tests.
 */
object ConfigValidator {
    const val MAX_TOKEN_LENGTH = 512
    const val MAX_DEVICE_NAME_LENGTH = 128

    private val SCHEME_PATTERN = Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://")
    private val HTTP_LOOPBACK_HOSTS = setOf("localhost", "127.0.0.1", "::1", "10.0.2.2")

    fun validate(serverUrl: String, apiToken: String, deviceName: String): ValidationResult {
        val errors = mutableMapOf<ConfigField, ConfigError>()
        val normalizedUrl = normalizeServerUrl(serverUrl)

        if (serverUrl.isBlank()) {
            errors[ConfigField.SERVER_URL] = ConfigError.SERVER_URL_EMPTY
        } else if (normalizedUrl == null) {
            errors[ConfigField.SERVER_URL] = ConfigError.SERVER_URL_INVALID
        }

        val token = apiToken.trim()
        if (token.isEmpty()) {
            errors[ConfigField.API_TOKEN] = ConfigError.API_TOKEN_EMPTY
        } else if (token.length > MAX_TOKEN_LENGTH) {
            errors[ConfigField.API_TOKEN] = ConfigError.API_TOKEN_TOO_LONG
        }

        val name = deviceName.trim()
        if (name.isEmpty()) {
            errors[ConfigField.DEVICE_NAME] = ConfigError.DEVICE_NAME_EMPTY
        } else if (name.length > MAX_DEVICE_NAME_LENGTH) {
            errors[ConfigField.DEVICE_NAME] = ConfigError.DEVICE_NAME_TOO_LONG
        }

        return ValidationResult(normalizedUrl, errors)
    }

    /**
     * Accepts HTTPS URLs and HTTP only for approved local development hosts. A missing scheme
     * is upgraded to HTTPS by default.
     */
    fun normalizeServerUrl(raw: String): String? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return null

        val candidate = if (SCHEME_PATTERN.containsMatchIn(trimmed)) trimmed else "https://$trimmed"
        return try {
            val uri = URI(candidate)
            val scheme = uri.scheme?.lowercase()
            if (scheme != "http" && scheme != "https") return null
            val host = uri.host?.lowercase() ?: return null
            val policyHost = host.removePrefix("[").removeSuffix("]")
            if (scheme == "http" && policyHost !in HTTP_LOOPBACK_HOSTS) return null
            // Credentials, query strings and fragments do not belong in a base URL.
            if (uri.userInfo != null || uri.rawQuery != null || uri.rawFragment != null) return null
            val path = uri.path.orEmpty().trimEnd('/')
            val port = if (uri.port == -1) "" else ":${uri.port}"
            "$scheme://${uri.host}$port$path"
        } catch (exception: URISyntaxException) {
            null
        }
    }
}
