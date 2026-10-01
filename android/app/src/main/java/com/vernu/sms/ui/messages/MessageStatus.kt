package com.vernu.sms.ui.messages

import com.vernu.sms.outbox.LocalState

enum class StatusTone { DELIVERED, SENT, PROGRESS, WARNING, ERROR, NEUTRAL }

/** What the Messages list shows for one outbound SMS. */
data class StatusView(val label: String, val tone: StatusTone, val detail: String?)

/**
 * Combines the server row with what this phone knows locally. The server alone
 * cannot tell "still waiting for a phone" from "on this phone, being sent";
 * both used to render as a bare "Pending".
 */
object MessageStatusMapper {
    private const val EXPIRED_CODE = "EXPIRED_MAX_AGE"

    fun describe(
        serverStatus: String?,
        errorCode: String?,
        errorMessage: String?,
        localState: LocalState?,
        localError: String?
    ): StatusView {
        return when (serverStatus?.lowercase()) {
            "delivered" -> StatusView("Delivered", StatusTone.DELIVERED, null)
            "sent" -> if (localState == LocalState.DELIVERED) {
                StatusView("Delivered", StatusTone.DELIVERED, "Delivery report syncing to the server")
            } else {
                StatusView("Sent", StatusTone.SENT, null)
            }
            "failed" -> StatusView(
                "Failed", StatusTone.ERROR,
                errorMessage ?: localError ?: "The SMS could not be sent"
            )
            "canceled" -> if (errorCode == EXPIRED_CODE) {
                StatusView("Expired", StatusTone.NEUTRAL, "Not sent within 2 hours, so it was canceled")
            } else {
                StatusView("Canceled", StatusTone.NEUTRAL, errorMessage)
            }
            "unknown" -> when (localState) {
                LocalState.SENT -> StatusView("Sent", StatusTone.SENT, "Confirmation syncing to the server")
                LocalState.DELIVERED -> StatusView("Delivered", StatusTone.DELIVERED, "Confirmation syncing to the server")
                else -> StatusView(
                    "No confirmation", StatusTone.WARNING,
                    "The phone never confirmed this SMS. Check the phone's Messages app before resending."
                )
            }
            else -> describeInFlight(serverStatus?.lowercase(), errorMessage, localState, localError)
        }
    }

    private fun describeInFlight(
        serverStatus: String?,
        errorMessage: String?,
        localState: LocalState?,
        localError: String?
    ): StatusView = when (localState) {
        LocalState.DELIVERED -> StatusView("Delivered", StatusTone.DELIVERED, "Confirmation syncing to the server")
        LocalState.SENT -> StatusView("Sent", StatusTone.SENT, "Confirmation syncing to the server")
        LocalState.SUBMITTED -> StatusView(
            "Sending", StatusTone.PROGRESS,
            "Handed to the phone's SMS app; waiting for the mobile network"
        )
        LocalState.QUEUED -> StatusView(
            "Queued on phone", StatusTone.PROGRESS,
            "On this phone, waiting for its turn (send delay between messages)"
        )
        LocalState.FAILED -> StatusView(
            "Retrying", StatusTone.WARNING,
            localError ?: "This phone could not send it; the server will retry"
        )
        LocalState.EXPIRED -> StatusView("Expired", StatusTone.NEUTRAL, "Not sent within 2 hours")
        // Handed back to the server (its lease ran out before this phone could
        // start it); shows like any SMS the phone does not hold.
        LocalState.LAPSED, null -> if (serverStatus == "dispatched") {
            StatusView(
                "Waiting for phone", StatusTone.PROGRESS,
                "Sent to this phone by the server; it is picked up on the next sync"
            )
        } else {
            StatusView(
                "Queued", StatusTone.PROGRESS,
                errorMessage ?: "Waiting in the server outbox for a free phone"
            )
        }
    }
}
