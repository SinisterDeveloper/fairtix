// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title FairTickets
/// @notice Event-scoped fair ticketing contract with attested entry, bounded Fisher-Yates draw,
///         primary claim, price-capped resale, pull payouts, and EIP-712 one-time gate admission.
contract FairTickets is EIP712 {
    using ECDSA for bytes32;

    bytes32 public constant ATTESTATION_TYPEHASH =
        keccak256("EntryAttestation(bytes32 editionId,bytes32 subject,address wallet,uint256 expiry)");
    bytes32 public constant GATE_TYPEHASH =
        keccak256("GateCredential(bytes32 editionId,uint256 slot,uint256 version,uint256 expiry)");

    struct Ticket {
        address owner;
        uint256 version;
        uint256 paidPrice;
        bool admitted;
    }

    struct Listing {
        address seller;
        uint256 price;
        bool active;
    }

    address public immutable organiser;
    address public immutable attester;
    address public immutable gate;
    uint256 public immutable capacity;
    uint256 public immutable facePrice;
    bytes32 public immutable editionId;

    uint64 public immutable entryDeadline;
    uint64 public immutable claimDuration;
    uint64 public immutable resaleDuration;
    uint64 public immutable gateDuration;

    bool public drawLocked;
    bool public drawn;
    uint256 public drawTargetBlock;
    bytes32 public drawTargetHash;
    uint256 public winnersCount;

    uint64 public claimDeadline;
    uint64 public resaleCutoff;
    uint64 public gateClose;

    uint256 public issuedCount;
    uint256 public admittedCount;

    address[] public entrants;
    mapping(bytes32 => bool) public subjectEntered;
    mapping(address => bool) public walletEntered;
    mapping(address => bytes32) public walletSubject;

    mapping(uint256 => uint256) private _fy;
    mapping(uint256 => address) public reservedWinner;
    mapping(address => uint256) public winnerSlot;
    mapping(address => bool) public claimedByWinner;

    mapping(uint256 => Ticket) public tickets;
    mapping(address => uint256) public heldSlot;
    mapping(uint256 => mapping(uint256 => Listing)) public listings;
    mapping(address => uint256) public proceeds;

    event Entered(address indexed wallet, bytes32 indexed subject, uint256 indexed index);
    event DrawLocked(uint256 indexed targetBlock, uint256 entrantsCount);
    event WinnerSelected(uint256 indexed slot, address indexed winner);
    event DrawCompleted(
        bytes32 indexed targetHash,
        uint256 winnersCount,
        uint64 claimDeadline,
        uint64 resaleCutoff,
        uint64 gateClose
    );
    event Claimed(uint256 indexed slot, address indexed owner, uint256 price);
    event Listed(uint256 indexed slot, uint256 indexed version, address indexed seller, uint256 price);
    event Resold(
        uint256 indexed slot,
        uint256 indexed listedVersion,
        uint256 newVersion,
        address seller,
        address indexed buyer,
        uint256 price
    );
    event Admitted(uint256 indexed slot, uint256 indexed version, bytes32 indexed scanId);
    event Withdrawn(address indexed payee, uint256 amount);

    constructor(
        address _organiser,
        address _attester,
        address _gate,
        uint256 _capacity,
        uint256 _facePrice,
        bytes32 _editionId,
        uint64 _entryDeadline,
        uint64 _claimDuration,
        uint64 _resaleDuration,
        uint64 _gateDuration
    ) EIP712("FairTickets", "1") {
        require(_organiser != address(0), "Invalid organiser");
        require(_attester != address(0), "Invalid attester");
        require(_gate != address(0), "Invalid gate");
        require(_capacity > 0, "Invalid capacity");
        require(_editionId != bytes32(0), "Invalid edition");
        require(_entryDeadline > block.timestamp, "Entry deadline in past");
        require(_claimDuration > 0 && _resaleDuration > 0 && _gateDuration > 0, "Invalid durations");

        organiser = _organiser;
        attester = _attester;
        gate = _gate;
        capacity = _capacity;
        facePrice = _facePrice;
        editionId = _editionId;
        entryDeadline = _entryDeadline;
        claimDuration = _claimDuration;
        resaleDuration = _resaleDuration;
        gateDuration = _gateDuration;
    }

    function enter(bytes32 subject, uint256 expiry, bytes calldata attestation) external {
        require(block.timestamp <= entryDeadline, "Entry closed");
        require(!drawLocked && !drawn, "Draw already started");
        require(subject != bytes32(0), "Invalid subject");
        require(block.timestamp <= expiry, "Attestation expired");
        require(!subjectEntered[subject], "Subject already entered");
        require(!walletEntered[msg.sender], "Wallet already entered");

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(ATTESTATION_TYPEHASH, editionId, subject, msg.sender, expiry))
        );
        require(digest.recover(attestation) == attester, "Invalid attestation");

        subjectEntered[subject] = true;
        walletEntered[msg.sender] = true;
        walletSubject[msg.sender] = subject;

        uint256 index = entrants.length;
        entrants.push(msg.sender);
        emit Entered(msg.sender, subject, index);
    }

    function lockDraw() external {
        require(block.timestamp > entryDeadline, "Entry still open");
        require(!drawLocked, "Draw already locked");
        require(!drawn, "Already drawn");

        drawLocked = true;
        drawTargetBlock = block.number + 2;
        emit DrawLocked(drawTargetBlock, entrants.length);
    }

    function draw() external {
        require(drawLocked, "Draw not locked");
        require(!drawn, "Already drawn");
        require(block.number > drawTargetBlock, "Target block not reached");
        require(block.number <= drawTargetBlock + 256, "Draw window missed");

        bytes32 targetHash = blockhash(drawTargetBlock);
        require(targetHash != bytes32(0), "Zero target hash");

        drawn = true;
        drawTargetHash = targetHash;

        uint64 cDeadline = uint64(block.timestamp) + claimDuration;
        uint64 rCutoff = cDeadline + resaleDuration;
        uint64 gClose = rCutoff + gateDuration;
        claimDeadline = cDeadline;
        resaleCutoff = rCutoff;
        gateClose = gClose;

        uint256 n = entrants.length;
        uint256 count = n < capacity ? n : capacity;
        winnersCount = count;

        bytes32 seed = keccak256(abi.encodePacked(targetHash, address(this), n));
        for (uint256 i = 0; i < count; ) {
            uint256 r = uint256(keccak256(abi.encodePacked(seed, i)));
            uint256 j = i + (r % (n - i));

            uint256 idxI = _fy[i] == 0 ? i : _fy[i] - 1;
            uint256 idxJ = _fy[j] == 0 ? j : _fy[j] - 1;
            _fy[j] = idxI + 1;

            address winner = entrants[idxJ];
            uint256 slot = i + 1;
            reservedWinner[slot] = winner;
            winnerSlot[winner] = slot;
            emit WinnerSelected(slot, winner);

            unchecked {
                ++i;
            }
        }

        emit DrawCompleted(targetHash, count, cDeadline, rCutoff, gClose);
    }

    function claim() external payable {
        require(drawn, "Draw not completed");
        require(block.timestamp <= claimDeadline, "Claim window closed");

        uint256 slot = winnerSlot[msg.sender];
        require(slot != 0, "Not a winner");
        require(!claimedByWinner[msg.sender], "Already claimed");
        require(msg.value == facePrice, "Incorrect payment");

        claimedByWinner[msg.sender] = true;
        Ticket storage t = tickets[slot];
        t.owner = msg.sender;
        t.version = 1;
        t.paidPrice = facePrice;
        t.admitted = false;

        heldSlot[msg.sender] = slot;
        ++issuedCount;
        proceeds[organiser] += msg.value;

        emit Claimed(slot, msg.sender, msg.value);
    }

    function list(uint256 slot, uint256 expectedVersion, uint256 price) external {
        require(drawn && block.timestamp > claimDeadline && block.timestamp <= resaleCutoff, "Not in resale window");

        Ticket storage t = tickets[slot];
        require(t.owner == msg.sender, "Not ticket owner");
        require(t.version == expectedVersion && expectedVersion != 0, "Version mismatch");
        require(!t.admitted, "Already admitted");

        uint256 maxPrice = t.paidPrice < facePrice ? t.paidPrice : facePrice;
        require(price <= maxPrice, "Price exceeds cap");

        Listing storage l = listings[slot][expectedVersion];
        require(l.seller == address(0), "Already listed for version");

        l.seller = msg.sender;
        l.price = price;
        l.active = true;

        emit Listed(slot, expectedVersion, msg.sender, price);
    }

    function buy(uint256 slot, uint256 listedVersion, uint256 expectedPrice) external payable {
        require(drawn && block.timestamp > claimDeadline && block.timestamp <= resaleCutoff, "Not in resale window");
        require(walletEntered[msg.sender], "Buyer not registered");
        require(heldSlot[msg.sender] == 0, "Buyer already holds ticket");

        Listing storage l = listings[slot][listedVersion];
        require(l.active, "Listing not active");
        require(l.seller != msg.sender, "Cannot buy own ticket");
        require(l.price == expectedPrice, "Price mismatch");
        require(msg.value == expectedPrice, "Incorrect payment");

        Ticket storage t = tickets[slot];
        require(t.owner == l.seller, "Seller no longer owner");
        require(t.version == listedVersion, "Version mismatch");
        require(!t.admitted, "Already admitted");

        uint256 maxPrice = t.paidPrice < facePrice ? t.paidPrice : facePrice;
        require(expectedPrice <= maxPrice, "Price exceeds cap");

        address seller = l.seller;
        l.active = false;

        heldSlot[seller] = 0;
        heldSlot[msg.sender] = slot;

        uint256 newVersion = listedVersion + 1;
        t.owner = msg.sender;
        t.version = newVersion;
        t.paidPrice = expectedPrice;

        proceeds[seller] += msg.value;

        emit Resold(slot, listedVersion, newVersion, seller, msg.sender, expectedPrice);
    }

    function redeem(
        uint256 slot,
        uint256 version,
        uint256 expiry,
        bytes calldata ownerSig,
        bytes32 scanId
    ) external {
        require(msg.sender == gate, "Only gate");
        require(drawn && block.timestamp > resaleCutoff && block.timestamp <= gateClose, "Not in gate window");

        Ticket storage t = tickets[slot];
        require(t.owner != address(0), "Ticket not issued");
        require(t.version == version && version != 0, "Version mismatch");
        require(!t.admitted, "Already admitted");
        require(block.timestamp <= expiry && expiry <= block.timestamp + 120, "Invalid expiry");

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(GATE_TYPEHASH, editionId, slot, version, expiry))
        );
        require(digest.recover(ownerSig) == t.owner, "Invalid owner signature");

        t.admitted = true;
        ++admittedCount;

        emit Admitted(slot, version, scanId);
    }

    function withdraw() external {
        uint256 amount = proceeds[msg.sender];
        require(amount > 0, "Nothing to withdraw");

        proceeds[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Transfer failed");

        emit Withdrawn(msg.sender, amount);
    }

    function entrantsCount() external view returns (uint256) {
        return entrants.length;
    }

    function getWinners() external view returns (address[] memory winners) {
        uint256 count = winnersCount;
        winners = new address[](count);
        for (uint256 i = 0; i < count; ) {
            winners[i] = reservedWinner[i + 1];
            unchecked {
                ++i;
            }
        }
    }

    function getTicket(uint256 slot)
        external
        view
        returns (address owner, uint256 version, uint256 paidPrice, bool admitted)
    {
        Ticket storage t = tickets[slot];
        return (t.owner, t.version, t.paidPrice, t.admitted);
    }

    function getListing(uint256 slot, uint256 version)
        external
        view
        returns (address seller, uint256 price, bool active)
    {
        Listing storage l = listings[slot][version];
        return (l.seller, l.price, l.active);
    }

    function unissuedCount() external view returns (uint256) {
        return capacity - issuedCount;
    }

    function phase() external view returns (string memory) {
        if (!drawn) {
            if (block.timestamp <= entryDeadline && !drawLocked) return "ENTRY";
            return "DRAW";
        }
        if (block.timestamp <= claimDeadline) return "CLAIM";
        if (block.timestamp <= resaleCutoff) return "RESALE";
        if (block.timestamp <= gateClose) return "GATE";
        return "CLOSED";
    }
}
