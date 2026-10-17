package com.dcc.clipboard

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.isVisible
import androidx.core.widget.doAfterTextChanged
import androidx.lifecycle.lifecycleScope
import com.dcc.clipboard.data.ClientConfig
import com.dcc.clipboard.data.ConfigError
import com.dcc.clipboard.data.ConfigField
import com.dcc.clipboard.data.ConfigValidator
import com.dcc.clipboard.data.StorageHelper
import com.dcc.clipboard.databinding.ActivityMainBinding
import com.dcc.clipboard.network.TestConnectionClient
import com.dcc.clipboard.network.TestConnectionResult
import com.dcc.clipboard.service.DccForegroundService
import com.google.android.material.snackbar.Snackbar
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private lateinit var storageHelper: StorageHelper
    private val testConnectionClient = TestConnectionClient()

    private val requestNotificationPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { }

    private var notificationPermissionRequested = false

    private val requestSmsPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        updatePermissionStatus()
        val message = if (granted) {
            R.string.permission_granted_message
        } else {
            R.string.permission_denied_message
        }
        Snackbar.make(binding.root, message, Snackbar.LENGTH_LONG).show()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        storageHelper = StorageHelper(this)
        bindSavedConfig()
        bindActions()
        updatePermissionStatus()
    }

    override fun onResume() {
        super.onResume()
        updatePermissionStatus()
        reconcileServiceState()
    }

    private fun bindSavedConfig() {
        val config = storageHelper.loadConfig()
        binding.serverUrlInput.setText(config.serverUrl)
        binding.apiTokenInput.setText(config.apiToken)

        val modelName = Build.MODEL?.trim().orEmpty()
        val fallbackName = getString(R.string.default_device_name_fallback)
        binding.deviceNameInput.setText(config.deviceName.ifBlank { modelName.ifBlank { fallbackName } })

        binding.serviceSwitch.isChecked = config.serviceEnabled
        binding.deviceIdText.text = getString(
            R.string.device_id_format,
            storageHelper.getOrCreateDeviceId(),
        )
        reconcileServiceState()
    }

    private fun bindActions() {
        binding.saveButton.setOnClickListener { saveConfig() }
        binding.testConnectionButton.setOnClickListener { testConnection() }
        binding.requestPermissionButton.setOnClickListener { requestSmsPermissionOrOpenSettings() }

        binding.serviceSwitch.setOnCheckedChangeListener { _, isChecked ->
            if (isChecked) {
                val config = validatedConfig()
                if (config == null) {
                    binding.serviceSwitch.isChecked = false
                    storageHelper.setServiceEnabled(false)
                    updateServiceStatus()
                    Snackbar.make(binding.root, R.string.service_config_invalid, Snackbar.LENGTH_LONG).show()
                    return@setOnCheckedChangeListener
                }
                storageHelper.saveConfig(config)
                storageHelper.setServiceEnabled(true)
                startCollectionService()
                Snackbar.make(binding.root, R.string.service_switch_saved, Snackbar.LENGTH_SHORT).show()
            } else {
                storageHelper.setServiceEnabled(false)
                stopCollectionService()
            }
            updateServiceStatus()
        }

        binding.serverUrlInput.doAfterTextChanged { binding.serverUrlLayout.error = null }
        binding.apiTokenInput.doAfterTextChanged { binding.apiTokenLayout.error = null }
        binding.deviceNameInput.doAfterTextChanged { binding.deviceNameLayout.error = null }
    }

    private fun saveConfig(showFeedback: Boolean = true): Boolean {
        val config = validatedConfig() ?: return false
        storageHelper.saveConfig(config)
        // Echo the normalized value so the user sees exactly what was stored.
        binding.serverUrlInput.setText(config.serverUrl)
        binding.serverUrlInput.setSelection(config.serverUrl.length)
        reconcileServiceState()
        if (showFeedback) {
            Snackbar.make(binding.root, R.string.save_success, Snackbar.LENGTH_SHORT).show()
        }
        return true
    }

    /**
     * Validates the current form and returns the config to use, without persisting it.
     * Saving is an explicit action; testing a connection must not overwrite stored values.
     */
    private fun validatedConfig(): ClientConfig? {
        val rawUrl = binding.serverUrlInput.text?.toString().orEmpty()
        val token = binding.apiTokenInput.text?.toString().orEmpty()
        val deviceName = binding.deviceNameInput.text?.toString().orEmpty()
        val validation = ConfigValidator.validate(rawUrl, token, deviceName)
        applyValidationErrors(validation.errors)
        if (!validation.isValid) return null

        return ClientConfig(
            serverUrl = requireNotNull(validation.normalizedServerUrl),
            apiToken = token.trim(),
            deviceName = deviceName.trim(),
            serviceEnabled = binding.serviceSwitch.isChecked,
        )
    }

    private fun applyValidationErrors(errors: Map<ConfigField, ConfigError>) {
        binding.serverUrlLayout.error = errors[ConfigField.SERVER_URL]?.let { getString(it.messageRes()) }
        binding.apiTokenLayout.error = errors[ConfigField.API_TOKEN]?.let { getString(it.messageRes()) }
        binding.deviceNameLayout.error = errors[ConfigField.DEVICE_NAME]?.let { getString(it.messageRes()) }
    }

    private fun ConfigError.messageRes(): Int = when (this) {
        ConfigError.SERVER_URL_EMPTY -> R.string.error_server_url_empty
        ConfigError.SERVER_URL_INVALID -> R.string.error_server_url_invalid
        ConfigError.API_TOKEN_EMPTY -> R.string.error_api_token_empty
        ConfigError.API_TOKEN_TOO_LONG -> R.string.error_api_token_too_long
        ConfigError.DEVICE_NAME_EMPTY -> R.string.error_device_name_empty
        ConfigError.DEVICE_NAME_TOO_LONG -> R.string.error_device_name_too_long
    }

    private fun testConnection() {
        hideTestResult()
        val config = validatedConfig()
        if (config == null) {
            showTestResult(getString(R.string.test_invalid_config), isSuccess = false)
            return
        }

        setTesting(true)
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                testConnectionClient.test(config, storageHelper.getOrCreateDeviceId())
            }
            if (isFinishing || isDestroyed) return@launch
            setTesting(false)
            renderTestResult(result)
        }
    }

    private fun setTesting(testing: Boolean) {
        binding.testProgress.isVisible = testing
        binding.testConnectionButton.isEnabled = !testing
        binding.saveButton.isEnabled = !testing
        binding.testConnectionButton.setText(
            if (testing) R.string.test_button_testing else R.string.test_button,
        )
    }

    private fun renderTestResult(result: TestConnectionResult) {
        when (result) {
            is TestConnectionResult.Success -> {
                val collectionId = result.collectionId ?: "—"
                val message = if (result.extractedCode != null) {
                    getString(
                        R.string.test_result_success_detail,
                        collectionId,
                        result.extractedCode,
                    )
                } else {
                    getString(R.string.test_result_success_no_code, collectionId)
                }
                showTestResult(
                    getString(R.string.test_result_success_title) + "\n" + message,
                    isSuccess = true,
                )
            }

            is TestConnectionResult.Rejected -> {
                val detail = result.serverMessage
                    ?: getString(defaultHttpMessage(result.httpStatus))
                showTestResult(
                    getString(R.string.test_result_failure_title) + "\n" +
                        getString(R.string.test_result_http_error, result.httpStatus, detail),
                    isSuccess = false,
                )
            }

            is TestConnectionResult.NetworkError -> {
                val detail = result.detail
                    ?: getString(R.string.test_result_network_error_generic)
                showTestResult(
                    getString(R.string.test_result_failure_title) + "\n" +
                        getString(R.string.test_result_network_error, detail),
                    isSuccess = false,
                )
            }
        }
    }

    private fun defaultHttpMessage(status: Int): Int = when {
        status == 400 -> R.string.http_error_400
        status == 401 -> R.string.http_error_401
        status == 403 -> R.string.http_error_403
        status == 404 -> R.string.http_error_404
        status == 413 -> R.string.http_error_413
        status == 429 -> R.string.http_error_429
        status in 500..599 -> R.string.http_error_5xx
        else -> R.string.http_error_unknown
    }

    private fun showTestResult(message: String, isSuccess: Boolean) {
        binding.testResultCard.isVisible = true
        binding.testResultText.text = message
        binding.testResultCard.setCardBackgroundColor(
            ContextCompat.getColor(
                this,
                if (isSuccess) R.color.result_success_container else R.color.result_error_container,
            ),
        )
        binding.testResultText.setTextColor(
            ContextCompat.getColor(
                this,
                if (isSuccess) R.color.result_success_text else R.color.result_error_text,
            ),
        )
    }

    private fun hideTestResult() {
        binding.testResultCard.isVisible = false
        binding.testResultText.text = null
    }

    private fun updatePermissionStatus() {
        val granted = hasSmsPermission()
        binding.permissionStatusText.setText(
            if (granted) R.string.permission_status_granted else R.string.permission_status_denied,
        )
        binding.permissionStatusText.setTextColor(
            ContextCompat.getColor(
                this,
                if (granted) R.color.result_success_text else R.color.result_error_text,
            ),
        )
        binding.requestPermissionButton.isEnabled = !granted
        binding.requestPermissionButton.setText(
            if (granted) R.string.permission_granted_button else permissionButtonLabel(),
        )
    }

    private fun permissionButtonLabel(): Int {
        val permanentlyDenied = storageHelper.wasPermissionRequested() &&
            !shouldShowRequestPermissionRationale(Manifest.permission.RECEIVE_SMS)
        return if (permanentlyDenied) {
            R.string.permission_open_settings_button
        } else {
            R.string.permission_request_button
        }
    }

    private fun requestSmsPermissionOrOpenSettings() {
        if (hasSmsPermission()) return
        val permanentlyDenied = storageHelper.wasPermissionRequested() &&
            !shouldShowRequestPermissionRationale(Manifest.permission.RECEIVE_SMS)
        if (permanentlyDenied) {
            Snackbar.make(binding.root, R.string.permission_settings_message, Snackbar.LENGTH_LONG)
                .show()
            startActivity(
                Intent(
                    Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.fromParts("package", packageName, null),
                ),
            )
        } else {
            storageHelper.markPermissionRequested()
            requestSmsPermission.launch(Manifest.permission.RECEIVE_SMS)
        }
    }

    private fun hasSmsPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECEIVE_SMS) ==
            PackageManager.PERMISSION_GRANTED

    private fun reconcileServiceState() {
        val config = storageHelper.loadConfig()
        val valid = ConfigValidator.validate(config.serverUrl, config.apiToken, config.deviceName).isValid
        val shouldRun = config.serviceEnabled && valid
        if (config.serviceEnabled && !valid) {
            storageHelper.setServiceEnabled(false)
            binding.serviceSwitch.isChecked = false
        }
        if (shouldRun) {
            startCollectionService()
        } else {
            stopCollectionService()
        }
        updateServiceStatus(shouldRun)
    }

    private fun startCollectionService() {
        requestNotificationPermissionIfNeeded()
        val intent = Intent(this, DccForegroundService::class.java)
        ContextCompat.startForegroundService(this, intent)
    }

    private fun stopCollectionService() {
        stopService(Intent(this, DccForegroundService::class.java))
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED && !notificationPermissionRequested
        ) {
            notificationPermissionRequested = true
            requestNotificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private fun updateServiceStatus(enabled: Boolean = binding.serviceSwitch.isChecked) {
        binding.serviceStatusText.setText(
            if (enabled) R.string.service_status_enabled else R.string.service_status_disabled,
        )
    }
}
