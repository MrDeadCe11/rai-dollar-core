pragma solidity 0.8.24;

import "./v0.8.24/Dependencies/Ownable.sol";
import "./v0.8.24/Dependencies/CheckContract.sol";
import "./v0.8.24/Interfaces/IRelayer.sol";
import "./v0.8.24/Interfaces/IRateControl.sol";

contract RateControl is Ownable, CheckContract, IRateControl {
    // What variable is controlled
    // Outputs a per-second delta rate, st. (1+delta_rate) = per-second rate
    bytes32 public constant controlVariable = "rate";

    // This value is multiplied with the error
    int256 public constant KP = 62793725775; // [EIGHTEEN_DECIMAL_NUMBER]

    // How long until the response doubles with constant error
    int256 public constant TIME_CONSTANT = 86400 * 7; // 7 days

    // This value is multiplied with errorIntegral
    int256 public KI = KP / TIME_CONSTANT; // [EIGHTEEN_DECIMAL_NUMBER]

    // Controller output bias
    int256 public CO_BIAS = 158153903837946259; // 0.5% annual, [TWENTY_SEVEN_DECIMAL_NUMBER]

    // The maximum output value
    int256 public OUTPUT_UPPER_BOUND = 12857214317438491659; // 50% annual [TWENTY_SEVEN_DECIMAL_NUMBER]

    // The minimum output value
    int256 public OUTPUT_LOWER_BOUND = 0; // [TWENTY_SEVEN_DECIMAL_NUMBER]

    // The max delta per hour
    //uint256 public constant MAX_DELTA_PER_HOUR = 158153903837946259; // 0.5% [TWENTY_SEVEN_DECIMAL_NUMBER]
    uint256 public constant MAX_DELTA_PER_HOUR = 79175443978840578; // 0.25% [TWENTY_SEVEN_DECIMAL_NUMBER]

    // The integral term (sum of error at each update call minus the leak applied at every call)
    int256 public errorIntegral; // [TWENTY_SEVEN_DECIMAL_NUMBER]

    // The last error
    int256 public lastError; // [TWENTY_SEVEN_DECIMAL_NUMBER]

    // The last output
    int256 public lastOutput = CO_BIAS; // [TWENTY_SEVEN_DECIMAL_NUMBER]

    // Timestamp of the last update
    uint256 public lastUpdateTime; // [timestamp]

    // Address that can update controller (relayer)
    IRelayer public relayer;

    uint256 internal constant TWENTY_SEVEN_DECIMAL_NUMBER = 10 ** 27;
    uint256 internal constant EIGHTEEN_DECIMAL_NUMBER = 10 ** 18;

    struct PiComponents {
        int256 p;
        int256 i;
    }

    event RelayerAddressChanged(address _relayerAddress);

    function setAddresses(address _relayerAddress) external override onlyOwner {
        checkContract(_relayerAddress);
        relayer = IRelayer(_relayerAddress);
        emit RelayerAddressChanged(_relayerAddress);

        _renounceOwnership();
    }

    function _requireCallerIsRelayer() internal view {
        require(msg.sender == address(relayer), "RateControl: Caller is not the Relayer contract");
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

    /*
    * @notice Return maximum of two int256 values
    * @param a first value
    * @param b second value
    */
    function max(int256 a, int256 b) internal pure returns (int256) {
        return a >= b ? a : b;
    }

    /*
    * @notice Return minimum of two int256 values
    * @param a first value
    * @param b second value
    */
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

        // compute output bounds for this update
        // for first output, timeElapsed=0 -> maxDelta=0
        int256 maxDelta = int256(MAX_DELTA_PER_HOUR * _timeElapsed / 3600);
        int256 upperBound = int256(min(OUTPUT_UPPER_BOUND, lastOutput + maxDelta));
        int256 lowerBound = int256(max(OUTPUT_LOWER_BOUND, lastOutput - maxDelta));

        // apply bounds and optional integral clamp
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
    function boundPiOutput(int256 piOutput) public view returns (int256) {
        int256 boundedPIOutput = piOutput;

        if (piOutput < OUTPUT_LOWER_BOUND) {
            boundedPIOutput = OUTPUT_LOWER_BOUND;
        } else if (piOutput > OUTPUT_UPPER_BOUND) {
            boundedPIOutput = OUTPUT_UPPER_BOUND;
        }

        return boundedPIOutput;
    }
    */

    /*
    * @notice Compute a new error Integral
    * @param error The system error
    * @param error Time elapsed since last update
    */
    function getNextErrorIntegral(int256 error, uint256 timeElapsed) public view returns (int256, int256) {
        // One first update, don't accumulate error in integral
        if (lastUpdateTime == 0) {
            return (0, 0);
        }

        int256 newTimeAdjustedError = (error + lastError) / 2 * int256(timeElapsed);

        return (errorIntegral + newTimeAdjustedError, newTimeAdjustedError);
    }
    /*
    * @notice Apply Kp to the error and Ki to the error integral(by multiplication) and then sum P and I
    * @param error The system error TWENTY_SEVEN_DECIMAL_NUMBER
    * @param errorIntegral The calculated error integral TWENTY_SEVEN_DECIMAL_NUMBER
    * @return pOutput, iOutput TWENTY_SEVEN_DECIMAL_NUMBER
    */
    function getRawPiOutput(int256 _error, int256 _errorI) external view returns (int256, int256) {
        PiComponents memory output = _getRawPiOutput(_error, _errorI);
        return (output.p, output.i);
    }

    /*
    * @notice Apply Kp to the error and Ki to the error integral(by multiplication) and then sum P and I
    * @param error The system error TWENTY_SEVEN_DECIMAL_NUMBER
    * @param errorIntegral The calculated error integral TWENTY_SEVEN_DECIMAL_NUMBER
    * @return PiComponents TWENTY_SEVEN_DECIMAL_NUMBER
    */
    function _getRawPiOutput(int256 _error, int256 _errorI) internal view returns (PiComponents memory) {
        int256 pOutput = _error * int256(KP) / int256(EIGHTEEN_DECIMAL_NUMBER);
        int256 iOutput = _errorI * int256(KI) / int256(EIGHTEEN_DECIMAL_NUMBER);
        return PiComponents(pOutput, iOutput);
    }

    /*
    * @notice Process a new error and return controller output. First update will output the bias
    * @param error The system error EIGHTEEN_DECIMAL_NUMBER
    */
    function update(int256 _error) external returns (int256, int256, int256) {
        _requireCallerIsRelayer();
        require(block.timestamp > lastUpdateTime, "RateControl/wait-longer");

        (int256 boundedPiOutput, int256 newErrorIntegral, int256 pOutput, int256 iOutput) = getNextPiOutput(_error);

        lastUpdateTime = block.timestamp;
        lastError = _error;
        lastOutput = boundedPiOutput;
        errorIntegral = newErrorIntegral;

        return (boundedPiOutput, pOutput, iOutput);
    }

    /*
    * @notice Compute and return the output given an error 
    * @param error The system error
    * @param timeElapsed Time since last update
    */

    function getNextPiOutput(int256 _error, uint256 _timeElapsed)
        public
        view
        returns (int256, int256, int256, int256)
    {
        (int256 newErrorIntegral, int256 newArea) = getNextErrorIntegral(_error, _timeElapsed);

        PiComponents memory output = _getRawPiOutput(_error, newErrorIntegral);
        int256 piOutput = output.p + output.i;

        (int256 boundedPiOutput, int256 clampedErrorIntegral) =
            boundAndClampPiOutput(CO_BIAS + piOutput, newErrorIntegral, newArea, _timeElapsed);

        return (boundedPiOutput, clampedErrorIntegral, output.p, output.i);
    }

    /*
    * @notice Compute and return the output given an error
    * @param error The system error
    */

    function getNextPiOutput(int256 _error) public view returns (int256, int256, int256, int256) {
        return getNextPiOutput(_error, elapsed());
    }

    /*
    * @notice Returns the time elapsed since the last update call
    */
    function elapsed() public view returns (uint256) {
        return (lastUpdateTime == 0) ? 0 : block.timestamp - lastUpdateTime;
    }
}

