// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IFairTickets {
    function enter(bytes32 subject, uint256 expiry, bytes calldata attestation) external;
    function claim() external payable;
    function list(uint256 slot, uint256 expectedVersion, uint256 price) external;
    function withdraw() external;
}

/// @title RejectingReceiver
/// @notice Test helper that can hold/list a ticket but rejects native ETH payouts on withdraw().
contract RejectingReceiver {
    bool public rejectPayout = true;

    function setRejectPayout(bool reject) external {
        rejectPayout = reject;
    }

    function callEnter(address target, bytes32 subject, uint256 expiry, bytes calldata attestation) external {
        IFairTickets(target).enter(subject, expiry, attestation);
    }

    function callClaim(address target) external payable {
        IFairTickets(target).claim{value: msg.value}();
    }

    function callList(address target, uint256 slot, uint256 expectedVersion, uint256 price) external {
        IFairTickets(target).list(slot, expectedVersion, price);
    }

    function callWithdraw(address target) external {
        IFairTickets(target).withdraw();
    }

    receive() external payable {
        if (rejectPayout) {
            revert("Payout rejected");
        }
    }
}
