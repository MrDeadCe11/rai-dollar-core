pragma solidity 0.8.24;

import "./v0.8.24/Dependencies/Ownable.sol";
import "./v0.8.24/Dependencies/CheckContract.sol";
import "./v0.8.24/Interfaces/IRelayer.sol";
import "./v0.8.24/Interfaces/IParControl.sol";

contract ParControl is Ownable, CheckContract, IParControl {
    // What variable is controlled
    bytes32 public constant controlVariable = "par";

    // This value is multiplied with the error
    int256 public constant KP = 2 * 10 ** 17; // $0.005 error -> $1.001 par [EIGHTEEN_DECIMAL_NUMBER]

    // How long until the response doubles with constant error
    int256 public constant TIME_CONSTANT = 86400 * 7; // 7 days

    // This value is multiplied with errorIntegral
    int256 public constant KI = KP / (86400 * 7); // [EIGHTEEN_DECIMAL_NUMBER]

    // Factor to strengthen output when par < 10**18
    int256 public constant NEGATIVE_CONTROL_MULTIPLIER = 1; // [EIGHTEEN_DECIMAL_NUMBER]

    // Controller output bias
    int256 public constant CO_BIAS = 10 ** 18; // [TWENTY_SEVEN_DECIMAL_NUMBER]

    // The per second leak applied to errorIntegral before the latest error is added
    uint256 public constant PER_SECOND_INTEGRAL_LEAK = 999998853923969313944895488; // 7-day half-life [TWENTY_SEVEN_DECIMAL_NUMBER]

    // The maximum output value
    int256 public constant OUTPUT_UPPER_BOUND = 125 * 10 ** 16; // $1.25 [TWENTY_SEVEN_DECIMAL_NUMBER]

    // The minimum output value
    int256 public constant OUTPUT_LOWER_BOUND = 85 * 10 ** 16; // $0.85 [TWENTY_SEVEN_DECIMAL_NUMBER]

    // The max delta per hour, $0.001
    uint256 public constant MAX_DELTA_PER_HOUR = 10 ** 15; // [TWENTY_SEVEN_DECIMAL_NUMBER]

    // The integral term (sum of error at each update call minus the leak applied at every call)
    int256 public errorIntegral; // [TWENTY_SEVEN_DECIMAL_NUMBER]

    // The last error
    int256 public lastError; // [TWENTY_SEVEN_DECIMAL_NUMBER]

    // The last output
    int256 public lastOutput = CO_BIAS; // [TWENTY_SEVEN_DECIMAL_NUMBER]

    // Timestamp of the last update
    uint256 public lastUpdateTime; // [timestamp]

    // Address that can update controller
    IRelayer public relayer;

    uint256 internal constant TWENTY_SEVEN_DECIMAL_NUMBER = 10 ** 27;
    uint256 internal constant EIGHTEEN_DECIMAL_NUMBER = 10 ** 18;

    event RelayerAddressChanged(address _relayerAddress);

    function setAddresses(address _relayerAddress) external override onlyOwner {
        checkContract(_relayerAddress);
        relayer = IRelayer(_relayerAddress);
        emit RelayerAddressChanged(_relayerAddress);

        _renounceOwnership();
    }

    function _requireCallerIsRelayer() internal view {
        require(msg.sender == address(relayer), "ParControl: Caller is not the Relayer contract");
    }

    function rpower(uint256 x, uint256 n, uint256 base) public pure returns (uint256 z) {
        assembly {
            switch x
            case 0 {
                switch n
                case 0 { z := base }
                default { z := 0 }
            }
            default {
                switch mod(n, 2)
                case 0 { z := base }
                default { z := x }
                let half := div(base, 2) // for rounding.
                for { n := div(n, 2) } n { n := div(n, 2) } {
                    let xx := mul(x, x)
                    if iszero(eq(div(xx, x), x)) { revert(0, 0) }
                    let xxRound := add(xx, half)
                    if lt(xxRound, xx) { revert(0, 0) }
                    x := div(xxRound, base)
                    if mod(n, 2) {
                        let zx := mul(z, x)
                        if and(iszero(iszero(x)), iszero(eq(div(zx, x), z))) { revert(0, 0) }
                        let zxRound := add(zx, half)
                        if lt(zxRound, zx) { revert(0, 0) }
                        z := div(zxRound, base)
                    }
                }
            }
        }
    }

    function max(int256 a, int256 b) internal pure returns (int256) {
        return a >= b ? a : b;
    }

    function min(int256 a, int256 b) internal pure returns (int256) {
        return a < b ? a : b;
    }

    /**
     * @notice Bounds the raw PI-controller output by both
     *         (a) absolute limits  and  (b) maximum slew-rate,
     *         and clamps the error-integral once if a bound is hit.
     *
     * @param _piOutput       Raw   P + I output for this step
     * @param _errorIntegral  Current accumulated integral term
     * @param _newArea        Signed area added to the integral this step
     * @param _timeElapsed    Seconds since the previous update
     *
     * @return boundedOutput   Output after both bounds are applied
     * @return clampedIntegral Possibly-clamped integral term
     */
    function boundAndClampPiOutput(int256 _piOutput, int256 _errorIntegral, int256 _newArea, uint256 _timeElapsed)
        public
        view
        returns (int256 boundedOutput, int256 clampedIntegral)
    {
        boundedOutput = _piOutput;
        clampedIntegral = _errorIntegral;

        /* ── compute the per-step Δ envelope ───────────────────────────── */
        int256 maxDelta = int256(MAX_DELTA_PER_HOUR * _timeElapsed / 3600);
        int256 upperBound = int256(min(OUTPUT_UPPER_BOUND, lastOutput + maxDelta));
        int256 lowerBound = int256(max(OUTPUT_LOWER_BOUND, lastOutput - maxDelta));

        /* ── apply bounds & optional integral clamp ────────────────────── */
        if (_piOutput < lowerBound) {
            boundedOutput = lowerBound;
            if (_newArea < 0 && _errorIntegral < 0) {
                clampedIntegral -= _newArea;
            }
        } else if (_piOutput > upperBound) {
            boundedOutput = upperBound;
            if (_newArea > 0 && _errorIntegral > 0) {
                clampedIntegral -= _newArea;
            }
        }
    }

    /*
    * @notice Compute a new error Integral
    * @param error The system error
    */
    function getNextErrorIntegral(int256 error, uint256 timeElapsed) public view returns (int256, int256) {
        // One first update, don't accumulate error in integral
        if (lastUpdateTime == 0) {
            return (0, 0);
        }

        //int256 newTimeAdjustedError = riemannSum(error, lastError) * int256(timeElapsed);
        int256 newTimeAdjustedError = (error + lastError) / 2 * int256(timeElapsed);

        uint256 accumulatedLeak = (PER_SECOND_INTEGRAL_LEAK == 1e27)
            ? TWENTY_SEVEN_DECIMAL_NUMBER
            : rpower(PER_SECOND_INTEGRAL_LEAK, timeElapsed, TWENTY_SEVEN_DECIMAL_NUMBER);
        int256 leakedErrorIntegral = int256(accumulatedLeak) * errorIntegral / int256(TWENTY_SEVEN_DECIMAL_NUMBER);

        return (leakedErrorIntegral + newTimeAdjustedError, newTimeAdjustedError);
    }

    /*
    * @notice Apply Kp to the error and Ki to the error integral(by multiplication) and then sum P and I
    * @param error The system error TWENTY_SEVEN_DECIMAL_NUMBER
    * @param errorIntegral The calculated error integral TWENTY_SEVEN_DECIMAL_NUMBER
    * @return totalOutput, pOutput, iOutput TWENTY_SEVEN_DECIMAL_NUMBER
    */
    function getRawPiOutput(int256 error, int256 errorI) public pure returns (int256, int256) {
        // output = P + I = Kp * error + Ki * errorI
        int256 pOutput = error * int256(KP) / int256(EIGHTEEN_DECIMAL_NUMBER);
        int256 iOutput = errorI * int256(KI) / int256(EIGHTEEN_DECIMAL_NUMBER);
        return (pOutput, iOutput);
    }

    function _increaseOutput(int256 piOutput) internal pure returns (int256) {
        // Strengthen par output in the negative direction
        if (piOutput < 0) {
            return piOutput * NEGATIVE_CONTROL_MULTIPLIER;
        }

        return piOutput;
    }

    /*
    * @notice Process a new error and return controller output
    * @param error The system error EIGHTEEN_DECIMAL_NUMBER
    */
    function update(int256 error) external returns (int256, int256, int256) {
        _requireCallerIsRelayer();
        uint256 timeElapsed = (lastUpdateTime == 0) ? 0 : block.timestamp - lastUpdateTime;

        require(block.timestamp > lastUpdateTime, "ParControl/wait-longer");

        (int256 newErrorIntegral, int256 newArea) = getNextErrorIntegral(error, timeElapsed);

        (int256 pOutput, int256 iOutput) = getRawPiOutput(error, newErrorIntegral);

        int256 piOutput = pOutput + iOutput;

        piOutput = _increaseOutput(piOutput);

        int256 boundedPiOutput;
        (boundedPiOutput, errorIntegral) =
            boundAndClampPiOutput(CO_BIAS + piOutput, newErrorIntegral, newArea, timeElapsed);

        lastUpdateTime = block.timestamp;
        lastError = error;
        lastOutput = boundedPiOutput;

        return (boundedPiOutput, pOutput, iOutput);
    }
    /*
    * @notice Compute and return the output given an error
    * @param error The system error
    */

    function getNextPiOutput(int256 error, uint256 timeElapsed) public view returns (int256, int256, int256) {
        (int256 newErrorIntegral, int256 newArea) = getNextErrorIntegral(error, timeElapsed);
        (int256 pOutput, int256 iOutput) = getRawPiOutput(error, newErrorIntegral);
        int256 piOutput = pOutput + iOutput;

        piOutput = _increaseOutput(piOutput);

        int256 boundedPiOutput;
        (boundedPiOutput,) = boundAndClampPiOutput(CO_BIAS + piOutput, newErrorIntegral, newArea, timeElapsed);

        return (boundedPiOutput, pOutput, iOutput);
    }

    /*
    * @notice Returns the time elapsed since the last update call
    */
    function elapsed() external view returns (uint256) {
        return (lastUpdateTime == 0) ? 0 : block.timestamp - lastUpdateTime;
    }
}
