// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

library Control {
    int256 constant ONE = 1e18;

    struct State {
        //  params
        int kp;
        int ki;
        int bias;
        int lowerBound;  // clamp (min output)
        int upperBound;  // clamp (max output)

        // state
        int integral;
        int prevError;
        uint lastUpdate;
    }

    function init(
        State storage s,
        int kp_,
        int ki_,
        int bias_,
        int lowerBound_,
        int upperBound_
    ) internal {
        s.kp = kp_;
        s.ki = ki_;
        s.bias = bias_;
        s.lowerBound = lowerBound_;
        s.upperBound = upperBound_;
        s.integral = 0;
        s.prevError = 0;
        s.lastUpdate = block.timestamp;
    }

    function deadbandError(int error, int deadband) internal pure returns (int){
        if (error <= -deadband) return error;
        if (error >=  deadband) return error;
        return 0;
    }

    function updateHoldIntegral(State storage s, int error)
        internal
        returns (uint output)
    {
        // Used when controller is saturated but not internally aware because its own bound
        // isn't being hit.
        // specifically in GlobalFeeRouter when toLP > toLPAndStaking
        // Reuse _step with dt = 0 so:
        //  - deltaIntegral = 0  (integral is held)
        //  - raw output still uses current P error and existing integral
        //  - all clamp logic inside _step is preserved
        (output,,) = _step(s, error, 0);

        // Advance timing and remember the last error so next
        // update computes a correct dt and integral area
        s.prevError  = error;
        s.lastUpdate = block.timestamp;
    }

    function _step(State storage s, int error, uint dt)
        private
        view
        returns (uint output, int newIntegral, int deltaIntegral)
    {
        deltaIntegral = ((s.prevError + error) / 2) * int(dt);
        newIntegral   = s.integral + deltaIntegral;

        int raw = s.bias + (s.kp * error + s.ki * newIntegral) / ONE;

        // Lower clamp + simple anti-windup
        if (raw <= s.lowerBound) {
            if (deltaIntegral < 0 && newIntegral < 0) {
                newIntegral -= deltaIntegral;
            }
            return (uint(s.lowerBound), newIntegral, deltaIntegral);
        }

        // Upper clamp + simple anti-windup
        if (raw >= s.upperBound) {
            if (deltaIntegral > 0 && newIntegral > 0) {
                newIntegral -= deltaIntegral;
            }
            return (uint(s.upperBound), newIntegral, deltaIntegral);
        }

        return (uint(raw), newIntegral, deltaIntegral);
    }

    function preview(State storage s, int error, uint nowTs)
        internal
        view
        returns (uint output, int previewIntegral, uint dt)
    {
        dt = nowTs - s.lastUpdate;
        (output, previewIntegral, ) = _step(s, error, dt);
    }

    function previewHoldIntegral(State storage s, int error)
        internal
        view
        returns (uint output, int previewIntegral, uint dt)
    {
        //dt = 0; // hold integral ⇒ no time advance
        (output, previewIntegral, /* deltaIntegral */) = _step(s, error, 0);
    }

    function update(State storage s, int error)
        internal
        returns (uint output)
    {
        uint dt = block.timestamp - s.lastUpdate;
        int newInt;
        (output, newInt, ) = _step(s, error, dt);
        s.integral   = newInt;
        s.prevError  = error;
        s.lastUpdate = block.timestamp;
    }
}
