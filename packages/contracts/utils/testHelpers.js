const { ethers } = require("hardhat")


const BN = require('bn.js')
const LockupContract = artifacts.require(("./LockupContract.sol"))
const Destructible = artifacts.require("./TestContracts/Destructible.sol")

const MoneyValues = {
  negative_5e17: "-" + web3.utils.toWei('500', 'finney'),
  negative_1e18: "-" + web3.utils.toWei('1', 'ether'),
  negative_10e18: "-" + web3.utils.toWei('10', 'ether'),
  negative_50e18: "-" + web3.utils.toWei('50', 'ether'),
  negative_100e18: "-" + web3.utils.toWei('100', 'ether'),
  negative_101e18: "-" + web3.utils.toWei('101', 'ether'),
  negative_eth: (amount) => "-" + web3.utils.toWei(amount, 'ether'),

  _zeroBN: web3.utils.toBN('0'),
  _1e18BN: web3.utils.toBN('1000000000000000000'),
  _10e18BN: web3.utils.toBN('10000000000000000000'),
  _100e18BN: web3.utils.toBN('100000000000000000000'),
  _100BN: web3.utils.toBN('100'),
  _110BN: web3.utils.toBN('110'),
  _150BN: web3.utils.toBN('150'),

  _MCR: web3.utils.toBN('1100000000000000000'),
  _ICR100: web3.utils.toBN('1000000000000000000'),
  _CCR: web3.utils.toBN('1500000000000000000'),
}

const TimeValues = {
  SECONDS_IN_ONE_MINUTE:  60,
  SECONDS_IN_ONE_HOUR:    60 * 60,
  SECONDS_IN_ONE_DAY:     60 * 60 * 24,
  SECONDS_IN_ONE_WEEK:    60 * 60 * 24 * 7,
  SECONDS_IN_SIX_WEEKS:   60 * 60 * 24 * 7 * 6,
  SECONDS_IN_ONE_MONTH:   60 * 60 * 24 * 30,
  SECONDS_IN_ONE_YEAR:    60 * 60 * 24 * 365,
  MINUTES_IN_ONE_WEEK:    60 * 24 * 7,
  MINUTES_IN_ONE_MONTH:   60 * 24 * 30,
  MINUTES_IN_ONE_YEAR:    60 * 24 * 365
}



class TestHelper {

  static dec(val, scale) {
    let zerosCount

    if (scale == 'ether') {
      zerosCount = 18
    } else if (scale == 'finney')
      zerosCount = 15
    else {
      zerosCount = scale
    }

    const strVal = val.toString()
    const strZeros = ('0').repeat(zerosCount)

    return strVal.concat(strZeros)
  }

  static squeezeAddr(address) {
    const len = address.length
    return address.slice(0, 6).concat("...").concat(address.slice(len - 4, len))
  }

  static getDifference(x, y) {
    const x_BN = web3.utils.toBN(x)
    const y_BN = web3.utils.toBN(y)

    return Number(x_BN.sub(y_BN).abs())
  }

  static assertIsApproximatelyEqual(x, y, error = 1000) {
    assert.isAtMost(this.getDifference(x, y), error)
  }

  static zipToObject(array1, array2) {
    let obj = {}
    array1.forEach((element, idx) => obj[element] = array2[idx])
    return obj
  }

  static getGasMetrics(gasCostList) {
    const minGas = Math.min(...gasCostList)
    const maxGas = Math.max(...gasCostList)

    let sum = 0;
    for (const gas of gasCostList) {
      sum += gas
    }

    if (sum === 0) {
      return {
        gasCostList: gasCostList,
        minGas: undefined,
        maxGas: undefined,
        meanGas: undefined,
        medianGas: undefined
      }
    }
    const meanGas = sum / gasCostList.length

    // median is the middle element (for odd list size) or element adjacent-right of middle (for even list size)
    const sortedGasCostList = [...gasCostList].sort()
    const medianGas = (sortedGasCostList[Math.floor(sortedGasCostList.length / 2)])
    return { gasCostList, minGas, maxGas, meanGas, medianGas }
  }

  static getGasMinMaxAvg(gasCostList) {
    const metrics = th.getGasMetrics(gasCostList)

    const minGas = metrics.minGas
    const maxGas = metrics.maxGas
    const meanGas = metrics.meanGas
    const medianGas = metrics.medianGas

    return { minGas, maxGas, meanGas, medianGas }
  }

  static getEndOfAccount(account) {
    const accountLast2bytes = account.slice((account.length - 4), account.length)
    return accountLast2bytes
  }

  static randDecayFactor(min, max) {
    const amount = Math.random() * (max - min) + min;
    const amountInWei = web3.utils.toWei(amount.toFixed(18), 'ether')
    return amountInWei
  }

  static randAmountInWei(min, max) {
    const amount = Math.random() * (max - min) + min;
    const amountInWei = web3.utils.toWei(amount.toString(), 'ether')
    return amountInWei
  }

  static randAmountInGWei(min, max) {
    const amount = Math.floor(Math.random() * (max - min) + min);
    const amountInWei = web3.utils.toWei(amount.toString(), 'gwei')
    return amountInWei
  }

  static makeWei(num) {
    return web3.utils.toWei(num.toString(), 'ether')
  }

  static appendData(results, message, data) {
    data.push(message + `\n`)
    for (const key in results) {
      data.push(key + "," + results[key] + '\n')
    }
  }

  static getRandICR(min, max) {
    const ICR_Percent = (Math.floor(Math.random() * (max - min) + min))

    // Convert ICR to a duint
    const ICR = web3.utils.toWei((ICR_Percent * 10).toString(), 'finney')
    return ICR
  }

  static computeICR(coll, debt, price) {
    const collBN = web3.utils.toBN(coll)
    const debtBN = web3.utils.toBN(debt)
    const priceBN = web3.utils.toBN(price)

    const ICR = debtBN.eq(this.toBN('0')) ?
      this.toBN('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')
      : collBN.mul(priceBN).div(debtBN)

    return ICR
  }

  static async ICRbetween100and110(account, troveManager, price) {
    const ICR = await troveManager.getCurrentICR(account, price)
    return (ICR.gt(MoneyValues._ICR100)) && (ICR.lt(MoneyValues._MCR))
  }

  static async isUndercollateralized(account, troveManager, price) {
    const ICR = await troveManager.getCurrentICR(account, price)
    return ICR.lt(MoneyValues._MCR)
  }

  static toBN(num) {
    return web3.utils.toBN(num)
  }

  static gasUsed(tx) {
    const gas = tx.receipt.gasUsed
    return gas
  }

  static ethUsed(tx) {
    const gas = this.toBN(tx.receipt.gasUsed)
    const gasPrice = this.toBN(tx.receipt.effectiveGasPrice)

    return gas.mul(gasPrice)
  }

  static applyLiquidationFee(ethAmount) {
    // just the gas compensation fee, not the penalty
    return ethAmount.mul(this.toBN(this.dec(995, 15))).div(MoneyValues._1e18BN)
    // const divided = ethAmount.div(this.toBN(200))
    // return ethAmount.sub(divided)
  }

  // --- Logging functions ---

  static logGasMetrics(gasResults, message) {
    console.log(
      `\n ${message} \n
      min gas: ${gasResults.minGas} \n
      max gas: ${gasResults.maxGas} \n
      mean gas: ${gasResults.meanGas} \n
      median gas: ${gasResults.medianGas} \n`
    )
  }

  static logAllGasCosts(gasResults) {
    console.log(
      `all gas costs: ${gasResults.gasCostList} \n`
    )
  }

  static logGas(gas, message) {
    console.log(
      `\n ${message} \n
      gas used: ${gas} \n`
    )
  }

  static async logActiveAccounts(contracts, n) {
    const count = await contracts.sortedTroves.getSize()
    const price = await contracts.priceFeedTestnet.getPrice()

    n = (typeof n == 'undefined') ? count : n

    let account = await contracts.sortedTroves.getLast()
    const head = await contracts.sortedTroves.getFirst()

    console.log(`Total active accounts: ${count}`)
    console.log(`First ${n} accounts, in ascending ICR order:`)

    let i = 0
    while (i < n) {
      const squeezedAddr = this.squeezeAddr(account)
      const coll = (await contracts.troveManager.Troves(account))[1]
      const debt = (await contracts.troveManager.Troves(account))[0]
      const ICR = await contracts.troveManager.getCurrentICR(account, price)

      console.log(`Acct: ${squeezedAddr}  coll:${coll}  debt: ${debt}  ICR: ${ICR}`)

      if (account == head) { break; }

      account = await contracts.sortedTroves.getPrev(account)

      i++
    }
  }

  static async logAccountsArray(accounts, troveManager, price, n) {
    const length = accounts.length

    n = (typeof n == 'undefined') ? length : n

    console.log(`Number of accounts in array: ${length}`)
    console.log(`First ${n} accounts of array:`)

    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i]

      const squeezedAddr = this.squeezeAddr(account)
      const coll = (await troveManager.Troves(account))[1]
      const debt = (await troveManager.Troves(account))[0]
      const ICR = await troveManager.getCurrentICR(account, price)

      console.log(`Acct: ${squeezedAddr}  coll:${coll}  debt: ${debt}  ICR: ${ICR}`)
    }
  }

  static logBN(label, x) {
    x = x.toString().padStart(18, '0')
    // TODO: thousand separators
    const integerPart = x.slice(0, x.length-18) ? x.slice(0, x.length-18) : '0'
    console.log(`${label}:`, integerPart + '.' + x.slice(-18))
  }

  // --- TCR and Recovery Mode functions ---

  // These functions use the PriceFeedTestNet view price function getPrice() which is sufficient for testing.
  // the mainnet contract PriceFeed uses fetchPrice, which is non-view and writes to storage.

  // To checkRecoveryMode / getTCR from the Liquity mainnet contracts, pass a price value - this can be the lastGoodPrice
  // stored in Liquity, or the current Chainlink ETHUSD price, etc.


  static async checkRecoveryModeContract(contracts) {
    const price = await contracts.priceFeedTestnet.getPrice()
    return contracts.troveManager.checkRecoveryMode(price)
  }
  /*
           uint entireSystemColl = getEntireSystemColl();
        uint entireSystemDebt = getEntireSystemDebt(_accRate);
        uint par = relayer.par();
    
        TCR = LiquityMath._computeCR(entireSystemColl, entireSystemDebt, _price, par);

        return TCR;
  */
  static async checkRecoveryMode(contracts) {
    const ccr = await contracts.troveManager.CCR()
    const price = await contracts.priceFeedTestnet.getPrice()
    const tcr = await contracts.troveManager.getTCR(price)

    return tcr.lt(ccr)
  }

  static async getTCR(contracts) {
    const price = await contracts.priceFeedTestnet.getPrice()
    return contracts.troveManager.getTCR(price)
  }

  // --- Gas compensation calculation functions ---

  // Given a composite debt, returns the actual debt  - i.e. subtracts the virtual debt.
  // Virtual debt = 50 LUSD.
  static async getActualDebtFromComposite(compositeDebt, contracts) {
    const issuedDebt = await contracts.troveManager.getActualDebtFromComposite(compositeDebt)
    return issuedDebt
  }

  static async getCollateralFromCollSurplusPool(contracts, account) {
    const rawHex = await web3.eth.call({
      to: contracts.collSurplusPool.address,
      data: contracts.collSurplusPool.contract.methods.getCollateral(account).encodeABI()
    });
    return this.toBN(rawHex)
  }

  static async getNominalICR(contracts, account) {
    const rawHex = await web3.eth.call({
      to: contracts.troveManager.address,
      data: contracts.troveManager.contract.methods.getNominalICR(account).encodeABI()
    });
    return this.toBN(rawHex)
  }

  // Adds the gas compensation (50 LUSD)
  static async getCompositeDebt(contracts, debt) {
    const compositeDebt = contracts.borrowerOperations.getCompositeDebt(debt)
    return compositeDebt
  }

  static async getTroveEntireColl(contracts, trove) {
    return this.toBN((await contracts.troveManager.getEntireDebtAndColl(trove))[1])
  }

  static async getTroveEntireDebt(contracts, trove) {
    return this.toBN((await contracts.troveManager.getTroveActualDebt(trove)))
    //return this.toBN((await contracts.troveManager.getEntireDebtAndColl(trove))[0])
    //return this.toBN(await contracts.troveManager.getTroveActualDebt(trove))
    //return await contracts.troveManager.getTroveActualDebt(trove)
  }

  static async mintCollateralTokens(contracts, accounts, amount) {  
    for (const account of accounts) {
      await contracts.collateralToken.mint(account, amount)
    }
  }

  static async approveCollateralTokens(contracts, accounts, amount) {
    for (const account of accounts) {
      await contracts.collateralToken.approve(contracts.activePool.address, amount, { from: account })
    }
  }

  static async mintCollateralTokensAndApproveActivePool(contracts, accounts, amount) {
    await this.mintCollateralTokens(contracts, accounts, amount)
    await this.approveCollateralTokens(contracts, accounts, amount)
  }

  static async getTroveStake(contracts, trove) {
    return (contracts.troveManager.getTroveStake(trove))
  }

  /*
   * given the requested LUSD amomunt in openTrove, returns the total debt
   * So, it adds the gas compensation and the borrowing fee
   */
  static async getOpenTroveTotalDebt(contracts, lusdAmount) {
    //const fee = await contracts.troveManager.getBorrowingFee(lusdAmount)
    const fee = this.toBN('0');
    const compositeDebt = await this.getCompositeDebt(contracts, lusdAmount)
    return compositeDebt.add(fee)
  }

  /*
   * given the desired total debt, returns the LUSD amount that needs to be requested in openTrove
   * So, it subtracts the gas compensation and then the borrowing fee
   */
  static async getOpenTroveLUSDAmount(contracts, totalDebt) {
    const actualDebt = await this.getActualDebtFromComposite(totalDebt, contracts)
    return this.getNetBorrowingAmount(contracts, actualDebt)
  }

  // Subtracts the borrowing fee
  static async getNetBorrowingAmount(contracts, debt) {
    return debt
    // there is no initial borrow fee anymore
    //const borrowingRate = await contracts.troveManager.getBorrowingRateWithDecay()
    //return this.toBN(debtWithFee).mul(MoneyValues._1e18BN).div(MoneyValues._1e18BN.add(borrowingRate))
  }

  // Adds the borrowing fee
  static async getAmountWithBorrowingFee(contracts, lusdAmount) {
    //const fee = await contracts.troveManager.getBorrowingFee(lusdAmount)
    const fee = this.toBN('0')
    return lusdAmount.add(fee)
  }

  // Adds the redemption fee
  static async getRedemptionGrossAmount(contracts, expected) {
    const redemptionRate = await contracts.troveManager.getRedemptionRate()
    return expected.mul(MoneyValues._1e18BN).div(MoneyValues._1e18BN.add(redemptionRate))
  }

  // Get's total collateral minus total gas comp, for a series of troves.
  static async getExpectedTotalCollMinusTotalGasComp(troveList, contracts) {
    let totalCollRemainder = web3.utils.toBN('0')

    for (const trove of troveList) {
      const remainingColl = this.getCollMinusGasComp(trove, contracts)
      totalCollRemainder = totalCollRemainder.add(remainingColl)
    }
    return totalCollRemainder
  }

  static getEmittedRedemptionValues(redemptionTx) {
    for (let i = 0; i < redemptionTx.logs.length; i++) {
      if (redemptionTx.logs[i].event === "Redemption") {

        const LUSDAmount = redemptionTx.logs[i].args[0]
        const totalLUSDRedeemed = redemptionTx.logs[i].args[1]
        //const totalNLUSDRedeemed = redemptionTx.logs[i].args[2]
        const totalCollateralDrawn = redemptionTx.logs[i].args[2]
        const CollateralFee = redemptionTx.logs[i].args[3]

        return [LUSDAmount, totalLUSDRedeemed, totalCollateralDrawn, CollateralFee]
      }
    }
    throw ("The transaction logs do not contain a redemption event")
  }
  static getEmittedDripValues(tx) {
    for (let i = 0; i < tx.logs.length; i++) {
      if (tx.logs[i].event === "Drip") {

        const stakePayment = tx.logs[i].args[0]
        const spPayment = tx.logs[i].args[1]

        return [stakePayment, spPayment]
      }
    }
    throw ("The transaction logs do not contain a drip event")
  }

  static getEmittedEtherSentValues(tx) {
    for (let i = 0; i < tx.logs.length; i++) {
      if (tx.logs[i].event === "EtherSent") {

        const to = tx.logs[i].args[0]
        const amount = tx.logs[i].args[1]

        return [to, amount]
      }
    }
    throw ("The transaction logs do not contain an EtherSent event")
  }

  static getEmittedParUpdateValues(updateTx) {
    for (let i = 0; i < updateTx.logs.length; i++) {
      if (updateTx.logs[i].event === "ParUpdated") {

        const par = updateTx.logs[i].args[0]
        const pOutput = updateTx.logs[i].args[1]
        const iOutput = updateTx.logs[i].args[2]
        const error = updateTx.logs[i].args[3]

        return [par, pOutput, iOutput, error]
      }
    }
    throw ("The transaction logs do not contain a par update event")
  }

  static getEmittedRateUpdateValues(updateTx) {
    for (let i = 0; i < updateTx.logs.length; i++) {
      if (updateTx.logs[i].event === "RateUpdated") {

        const rate = updateTx.logs[i].args[0]
        const pOutput = updateTx.logs[i].args[1]
        const iOutput = updateTx.logs[i].args[2]
        const error = updateTx.logs[i].args[3]

        return [rate, pOutput, iOutput, error]
      }
    }
    throw ("The transaction logs do not contain a rate update event")
  }

  static getEmittedLiquidationValues(liquidationTx) {
    for (let i = 0; i < liquidationTx.logs.length; i++) {
      if (liquidationTx.logs[i].event === "Liquidation") {
        const liquidatedDebt = liquidationTx.logs[i].args[0]
        const liquidatedColl = liquidationTx.logs[i].args[1]
        const collGasComp = liquidationTx.logs[i].args[2]
        const lusdGasComp = liquidationTx.logs[i].args[3]

        return [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp]
      }
    }
    throw ("The transaction logs do not contain a liquidation event")
  }

  static getMultipleEmittedLiquidationValues(tx, n) {
    const debts = []
    const colls = []
    const gasComps = []
    const lusdComps = []
    for (let i = 0; i < tx.logs.length; i++) {
      if (tx.logs[i].event === "Liquidation") {
        const liquidatedDebt = tx.logs[i].args[0]
        const liquidatedColl = tx.logs[i].args[1]
        const collGasComp = tx.logs[i].args[2]
        const lusdGasComp = tx.logs[i].args[3]

        debts.push(liquidatedDebt)
        colls.push(liquidatedColl)
        gasComps.push(collGasComp)
        lusdComps.push(lusdGasComp )
      }
    }

    console.log("len", debts.length) 
    if (debts.length != 3) {
      throw (`The transaction logs do not contain ${n} liquidation events`)
    }
    return debt.concat(colls).concat(gasComps).concat(lusdComps)
  }

  static getEmittedPUpdated(pUpdatedTx) {
    for (let i = 0; i < pUpdatedTx.logs.length; i++) {
      if (pUpdatedTx.logs[i].event === "P_Updated") {
        const newP = pUpdatedTx.logs[i].args[0]

        return newP
      }
    }
    throw ("The transaction logs do not contain a P_Updated event")
  }

  static getEmittedDistributeToSP(tx) {
    for (let i = 0; i < tx.logs.length; i++) {
      if (tx.logs[i].event === "DistributeToSP") {
        const lusdGain = tx.logs[i].args[0]

        return lusdGain
      }
    }
    throw ("The transaction logs do not contain a DistributeToSP event")
  }
  static getEmittedOffset(tx) {
    for (let i = 0; i < tx.logs.length; i++) {
      if (tx.logs[i].event === "Offset") {
        const debt = tx.logs[i].args[0]

        return debt
      }
    }
    throw ("The transaction logs do not contain an Offset event")
  }

  static getEmittedTroveUpdateValues(troveUpdateTx) {
    for (let i = 0; i < troveUpdateTx.logs.length; i++) {
      if (troveUpdateTx.logs[i].event === "TroveUpdated") {
        const borrower = troveUpdateTx.logs[i].args[0]
        const debt = troveUpdateTx.logs[i].args[1]
        const coll = troveUpdateTx.logs[i].args[2]
        const stake = troveUpdateTx.logs[i].args[3]
        const operation = troveUpdateTx.logs[i].args[4]

        return [borrower, debt, coll, stake, operation]
      }
    }
    throw ("The transaction logs do not contain a trove update event")
  }

  static getEmittedTroveICRValues(troveUpdateTx) {
    for (let i = 0; i < troveUpdateTx.logs.length; i++) {
      if (troveUpdateTx.logs[i].event === "TroveICR") {
        const icr = troveUpdateTx.logs[i].args[0]
        const value = troveUpdateTx.logs[i].args[1]
        const compDebt = troveUpdateTx.logs[i].args[2]
        const price = troveUpdateTx.logs[i].args[3]
        const par = troveUpdateTx.logs[i].args[4]

        return [icr, value, compDebt, price, par]
      }
    }
    throw ("The transaction logs do not contain a trove update event")
  }

  static getEmittedLiquidatedDebt(liquidationTx) {
    return this.getLiquidationEventArg(liquidationTx, 0)  // LiquidatedDebt is position 0 in the Liquidation event
  }

  static getEmittedLiquidatedColl(liquidationTx) {
    return this.getLiquidationEventArg(liquidationTx, 1) // LiquidatedColl is position 1 in the Liquidation event
  }

  static getEmittedGasComp(liquidationTx) {
    return this.getLiquidationEventArg(liquidationTx, 2) // GasComp is position 2 in the Liquidation event
  }

  static getLiquidationEventArg(liquidationTx, arg) {
    for (let i = 0; i < liquidationTx.logs.length; i++) {
      if (liquidationTx.logs[i].event === "Liquidation") {
        return liquidationTx.logs[i].args[arg]
      }
    }

    throw ("The transaction logs do not contain a liquidation event")
  }

  static getLUSDFeeFromLUSDBorrowingEvent(tx) {
    for (let i = 0; i < tx.logs.length; i++) {
      if (tx.logs[i].event === "LUSDBorrowingFeePaid") {
        return (tx.logs[i].args[1]).toString()
      }
    }
    throw ("The transaction logs do not contain an LUSDBorrowingFeePaid event")
  }

  static getEventArgByIndex(tx, eventName, argIndex) {
    for (let i = 0; i < tx.logs.length; i++) {
      if (tx.logs[i].event === eventName) {
        return tx.logs[i].args[argIndex]
      }
    }
    throw (`The transaction logs do not contain event ${eventName}`)
  }

  static getEventArgByName(tx, eventName, argName) {
    for (let i = 0; i < tx.logs.length; i++) {
      if (tx.logs[i].event === eventName) {
        const keys = Object.keys(tx.logs[i].args)
        for (let j = 0; j < keys.length; j++) {
          if (keys[j] === argName) {
            return tx.logs[i].args[keys[j]]
          }
        }
      }
    }

    throw (`The transaction logs do not contain event ${eventName} and arg ${argName}`)
  }

  static getRawEventArgByName(tx, iFace, contractAddr, eventName, argName) {
    const log = tx.receipt.rawLogs                 // all logs in the tx
      .filter(l => l.address === contractAddr)  // keep SP only
      .map   (l => iFace.parseLog(l))                  // ABI‑decode
      .find  (l => l.name === eventName);         // pick the one

    return log.args[argName]
  }

  static getAllRawEventArgByName(tx, iFace, contractAddr, eventName, argName) {
    const log = tx.receipt.rawLogs                 // all logs in the tx
      .filter(l => l.address === contractAddr)  // keep SP only
      .map   (l => iFace.parseLog(l))                  // ABI‑decode
      .find  (l => l.name === eventName);         // pick the one

    return log

    //throw (`The transaction logs do not contain event ${eventName} and arg ${argName}`)
  }

  static getAllEventsByName(tx, eventName) {
    const events = []
    for (let i = 0; i < tx.logs.length; i++) {
      if (tx.logs[i].event === eventName) {
        events.push(tx.logs[i])
      }
    }
    return events
  }

  static getDebtAndCollFromTroveUpdatedEvents(troveUpdatedEvents, address) {
    const event = troveUpdatedEvents.filter(event => event.args[0] === address)[0]
    return [event.args[1], event.args[2]]
  }

  static async getBorrowerOpsListHint(contracts, newColl, newDebt) {
    const newNICR = await contracts.hintHelpers.computeNominalCR(newColl, newDebt)
    const {
      hintAddress: approxfullListHint,
      latestRandomSeed
    } = await contracts.hintHelpers.getApproxHint(newNICR, 5, this.latestRandomSeed)
    this.latestRandomSeed = latestRandomSeed

    const {0: upperHint, 1: lowerHint} = await contracts.sortedTroves.findInsertPosition(newNICR, approxfullListHint, approxfullListHint)
    return {upperHint, lowerHint}
  }

  static async getEntireCollAndDebt(contracts, account) {
    // console.log(`account: ${account}`)
    const rawColl = (await contracts.troveManager.Troves(account))[1]
    const rawDebt = (await contracts.troveManager.Troves(account))[0]
    const pendingETHReward = await contracts.troveManager.getPendingCollateralReward(account)
    const pendingLUSDDebtReward = await contracts.troveManager.getPendingLUSDDebtReward(account)
    const entireColl = rawColl.add(pendingETHReward)
    const entireDebt = rawDebt.add(pendingLUSDDebtReward)

    return { entireColl, entireDebt }
  }

  static async getCollAndDebtFromAddColl(contracts, account, amount) {
    const { entireColl, entireDebt } = await this.getEntireCollAndDebt(contracts, account)

    const newColl = entireColl.add(this.toBN(amount))
    const newDebt = entireDebt
    return { newColl, newDebt }
  }

  static async getCollAndDebtFromWithdrawColl(contracts, account, amount) {
    const { entireColl, entireDebt } = await this.getEntireCollAndDebt(contracts, account)
    // console.log(`entireColl  ${entireColl}`)
    // console.log(`entireDebt  ${entireDebt}`)

    const newColl = entireColl.sub(this.toBN(amount))
    const newDebt = entireDebt
    return { newColl, newDebt }
  }

  static async getCollAndDebtFromWithdrawLUSD(contracts, account, amount) {
    //const fee = await contracts.troveManager.getBorrowingFee(amount)
    const fee = this.toBN('0')
    const { entireColl, entireDebt } = await this.getEntireCollAndDebt(contracts, account)

    const newColl = entireColl
    const newDebt = entireDebt.add(this.toBN(amount)).add(fee)

    return { newColl, newDebt }
  }

  static async getCollAndDebtFromRepayLUSD(contracts, account, amount) {
    const { entireColl, entireDebt } = await this.getEntireCollAndDebt(contracts, account)

    const newColl = entireColl
    const newDebt = entireDebt.sub(this.toBN(amount))

    return { newColl, newDebt }
  }

  static async getCollAndDebtFromAdjustment(contracts, account, ETHChange, LUSDChange) {
    const { entireColl, entireDebt } = await this.getEntireCollAndDebt(contracts, account)

    // const coll = (await contracts.troveManager.Troves(account))[1]
    // const debt = (await contracts.troveManager.Troves(account))[0]

    //const fee = LUSDChange.gt(this.toBN('0')) ? await contracts.troveManager.getBorrowingFee(LUSDChange) : this.toBN('0')
    const fee = this.toBN('0');
    const newColl = entireColl.add(ETHChange)
    const newDebt = entireDebt.add(LUSDChange).add(fee)

    return { newColl, newDebt }
  }

  static async depositorValuesAfterLiquidation(contracts, tx, startDeposits, totalDeposits = null) {
      // retursn eth *gains* concatenated with SP deposits
      // does *not* return final eth balance, ie sp.getDepositorGain()
      const [,drip] = await this.getEmittedDripValues(tx)
      const stabilityPoolInterface = (await ethers.getContractAt("StabilityPool", contracts.stabilityPool.address)).interface;
      var collToAdd = this.toBN(await this.getRawEventArgByName(tx, stabilityPoolInterface, contracts.stabilityPool.address, "Offset", "collToAdd"))
      var debtToOffset = this.toBN(await this.getRawEventArgByName(tx, stabilityPoolInterface, contracts.stabilityPool.address, "Offset", "debtToOffset"))

      // Sometimes sum of deposits is not exactly equaling deposits, possibly exacerbated with increasing scales
      // In this case, allow totalDeposits to be passed in and not derived from individual deposits
      //
      if (totalDeposits == null) {
          totalDeposits = web3.utils.toBN('0');
          startDeposits.forEach( num => {
              totalDeposits = totalDeposits.add(num);
          })
      }

      // distribute drip gain
      const drippedDeposits = []
      for (const dep of startDeposits) {
          // how much depositor gets from drip
          const depositorDrip = drip.mul(dep).div(totalDeposits)
          const dripDeposit = dep.add(depositorDrip)
          drippedDeposits.push(dripDeposit)
      }

      const totalDepositsWithDrip = totalDeposits.add(drip)

      // Logic from SP.getMaxAmountToOffset()
      // TODO: is this needed? Offset event above is after SP.getMaxAmountToOffset() check in troveManager
      /*
      const amountToLeave = totalDepositsWithDrip < this.toBN(this.dec(1,18)) ? totalDepositsWithDrip: this.toBN(this.dec(1,18));
      const available = totalDepositsWithDrip.sub(amountToLeave)
      if (debtToOffset.gte(available)) {
          debtToOffset = available
      }
      */

      // distribute collateral
      const finalGains = []
      const finalDeposits = []
      for (const dep of drippedDeposits) {

          // depositor loss from liquidation
          const depositorGain = collToAdd.mul(dep).div(totalDepositsWithDrip.add(this.toBN('1')))
          const depositorLoss = debtToOffset.mul(dep).div(totalDepositsWithDrip)

          // depositor deposit remaining after drip and loss from liquidation offset
          const finalDeposit = dep.sub(depositorLoss)

          finalGains.push(depositorGain)
          finalDeposits.push(finalDeposit)
      }

      return finalGains.concat(finalDeposits)
  }
  static async depositorValuesAfterTwoLiquidations(contracts, tx1, tx2, startDeposits, totalDeposits = null, totalDeposits1 = null) {
      // retursn eth *gains* concatenated with SP deposits
      // does *not* return final eth balance, ie sp.getDepositorGain()
      const gainsDeposits1 = await this.depositorValuesAfterLiquidation(contracts, tx1, startDeposits, totalDeposits)

      const deposits1 = gainsDeposits1.slice(gainsDeposits1.length/2)
      const gains1 = gainsDeposits1.slice(0, gainsDeposits1.length/2)

      const gainsDeposits2 = await this.depositorValuesAfterLiquidation(contracts, tx2, deposits1, totalDeposits1)

      const deposits2 = gainsDeposits2.slice(gainsDeposits2.length/2)
      const gains2 = gainsDeposits2.slice(0, gainsDeposits2.length/2)

      if (gains1.length != gains2.length) {
          throw new Error("Gains arrays are not equal length");
      }

      const gainsSum = gains1.map(function(v, i) {
          return v.add(gains2[i]);
      })

      return gainsSum.concat(deposits2)

  }

  static async depositorValuesAfterThreeLiquidations(contracts, tx1, tx2, tx3, startDeposits, totalDeposits = null, totalDeposits1 = null, totalDeposits2 = null) {
      // retursn eth *gains* concatenated with SP deposits
      // does *not* return final eth balance, ie sp.getDepositorGain()
      const gainsDeposits1 = await this.depositorValuesAfterLiquidation(contracts, tx1, startDeposits, totalDeposits)

      const deposits1 = gainsDeposits1.slice(gainsDeposits1.length/2)
      const gains1 = gainsDeposits1.slice(0, gainsDeposits1.length/2)

      const gainsDeposits2 = await this.depositorValuesAfterLiquidation(contracts, tx2, deposits1, totalDeposits1)

      const deposits2 = gainsDeposits2.slice(gainsDeposits2.length/2)
      const gains2 = gainsDeposits2.slice(0, gainsDeposits2.length/2)

      const gainsDeposits3 = await this.depositorValuesAfterLiquidation(contracts, tx3, deposits2, totalDeposits2)

      const deposits3 = gainsDeposits3.slice(gainsDeposits3.length/2)
      const gains3 = gainsDeposits3.slice(0, gainsDeposits3.length/2)

      if (gains1.length != gains2.length) {
          throw new Error("Gains arrays are not equal length");
      }
      if (gains2.length != gains3.length) {
          throw new Error("Gains arrays are not equal length");
      }

      const gainsSum = gains1.map(function(v, i) {
          return v.add(gains2[i]).add(gains3[i]);
      })

      return gainsSum.concat(deposits3)

  }

  static async ethGainsAfterLiquidation(contracts, tx, startDeposits, totalDeposits = null) {
      const [,drip] = await this.getEmittedDripValues(tx)
      const stabilityPoolInterface = (await ethers.getContractAt("StabilityPool", contracts.stabilityPool.address)).interface;
      var collToAdd = this.toBN(await this.getRawEventArgByName(tx, stabilityPoolInterface, contracts.stabilityPool.address, "Offset", "collToAdd"))
      var debtToOffset = this.toBN(await this.getRawEventArgByName(tx, stabilityPoolInterface, contracts.stabilityPool.address, "Offset", "debtToOffset"))

      // Sometimes sum of deposits is not exactly equaling deposits, possibly exacerbated with increasing scales
      // In this case, allow totalDeposits to be passed in and not derived from individual deposits
      //
      if (totalDeposits == null) {
          totalDeposits = web3.utils.toBN('0');
          startDeposits.forEach( num => {
              totalDeposits = totalDeposits.add(num);
          })
      }

      // distribute drip gain
      const drippedDeposits = []
      for (const dep of startDeposits) {
          // how much depositor gets from drip
          const depositorDrip = drip.mul(dep).div(totalDeposits)
          const dripDeposit = dep.add(depositorDrip)
          drippedDeposits.push(dripDeposit)
      }

      const totalDepositsWithDrip = totalDeposits.add(drip)

      // Logic from SP.getMaxAmountToOffset()
      // TODO: is this needed? Offset event above is after SP.getMaxAmountToOffset() check in troveManager
      /*
      const amountToLeave = totalDepositsWithDrip < this.toBN(this.dec(1,18)) ? totalDepositsWithDrip: this.toBN(this.dec(1,18));
      const available = totalDepositsWithDrip.sub(amountToLeave)
      if (debtToOffset.gte(available)) {
          debtToOffset = available
      }
      */

      // distribute collateral
      const finalColls = []
      const finalDeposits = []
      for (const dep of drippedDeposits) {

          // depositor loss from liquidation
          const depositorGain = collToAdd.mul(dep).div(totalDepositsWithDrip.add(this.toBN('1')))
          const depositorLoss = debtToOffset.mul(dep).div(totalDepositsWithDrip)

          // depositor deposit remaining after drip and loss from liquidation offset
          const finalDeposit = dep.sub(depositorLoss)

          finalColls.push(depositorGain)
          finalDeposits.push(finalDeposit)
      }

      return [finalColls, finalDeposits]

  }

  static async ethGainsAfterTwoLiquidations(contracts, tx1, tx2, startDeposits, totalDeposits = null, totalDeposits1 = null) {
      const [colls1, deposits1] = await this.ethGainsAfterLiquidation(contracts, tx1, startDeposits, totalDeposits)

      const [colls2, deposits2] = await this.ethGainsAfterLiquidation(contracts, tx2, deposits1, totalDeposits1)

      if (colls1.length != colls2.length) {
          throw new Error("Collaterals arrays are not equal length");
      }

      return colls1.map(function(v, i) {
          return v.add(colls2[i]);
      })

  }

  static async ethGainsAfterThreeLiquidations(contracts, tx1, tx2, tx3, startDeposits, totalDeposits = null, totalDeposits1 = null, totalDeposits2 = null) {
      const [colls1, deposits1] = await this.ethGainsAfterLiquidation(contracts, tx1, startDeposits, totalDeposits)

      const [colls2, deposits2] = await this.ethGainsAfterLiquidation(contracts, tx2, deposits1, totalDeposits1)

      const [colls3, deposits3] = await this.ethGainsAfterLiquidation(contracts, tx3, deposits2, totalDeposits2)

      if (colls1.length != colls2.length) {
          throw new Error("Collaterals arrays are not equal length");
      }
      if (colls2.length != colls3.length) {
          throw new Error("Collaterals arrays are not equal length");
      }

      return colls1.map(function(v, i) {
          return v.add(colls2[i]).add(colls3[i]);
      })

  }

  static async depositsAfterLiquidation(contracts, tx, startDeposits, totalDeposits = null) {
      const [,drip] = await this.getEmittedDripValues(tx)
      const stabilityPoolInterface = (await ethers.getContractAt("StabilityPool", contracts.stabilityPool.address)).interface;
      var offsetDebt = this.toBN(await this.getRawEventArgByName(tx, stabilityPoolInterface, contracts.stabilityPool.address, "Offset", "debtToOffset"))

      // Sometimes sum of deposits is not exactly equaling deposits, possibly exacerbated with increasing scales
      // In this case, allow totalDeposits to be passed in and not derived from individual deposits
      //
      if (totalDeposits == null) {
          totalDeposits = web3.utils.toBN('0');
          startDeposits.forEach( num => {
              totalDeposits = totalDeposits.add(num);
          })
      }

      // distribute drip gain
      const drippedDeposits = []
      for (const dep of startDeposits) {
          // how much depositor gets from drip
          const depositorDrip = drip.mul(dep).div(totalDeposits)
          const dripDeposit = dep.add(depositorDrip)
          drippedDeposits.push(dripDeposit)
      }

      const totalDepositsWithDrip = totalDeposits.add(drip)

      // Logic from SP.getMaxAmountToOffset()
      // TODO: is this needed? Offset event above is after SP.getMaxAmountToOffset() check in troveManager
      /*
      const amountToLeave = totalDepositsWithDrip < this.toBN(this.dec(1,18)) ? totalDepositsWithDrip: this.toBN(this.dec(1,18));
      const available = totalDepositsWithDrip.sub(amountToLeave)
      if (offsetDebt.gte(available)) {
          offsetDebt = available
      }
      */

      // distribute debt loss
      const finalDeposits = []
      for (const dep of drippedDeposits) {

          // depositor loss from liquidation
          const depositorLoss = offsetDebt.mul(dep).div(totalDepositsWithDrip.add(this.toBN('1')))
          //const depositorLoss = offsetDebt.mul(dep).div(totalDepositsWithDrip)

          // depositor deposit remaining after drip and loss from liquidation offset
          const finalDeposit = dep.sub(depositorLoss)

          finalDeposits.push(finalDeposit)
      }

      return finalDeposits

  }

  static async depositsAfterTwoLiquidations(contracts, tx1, tx2, startDeposits, totalDeposits = null, totalDeposits2 = null) {
      const startDeposits2 = await this.depositsAfterLiquidation(contracts, tx1, startDeposits, totalDeposits)

      const finalDeposits = await this.depositsAfterLiquidation(contracts, tx2, startDeposits2, totalDeposits2)

      return finalDeposits

  }

  static async depositsAfterThreeLiquidations(contracts, tx1, tx2, tx3, startDeposits, totalDeposits = null, totalDeposits2 = null, totalDeposits3 = null) {
      const startDeposits2 = await this.depositsAfterLiquidation(contracts, tx1, startDeposits, totalDeposits)

      const startDeposits3 = await this.depositsAfterLiquidation(contracts, tx2, startDeposits2, totalDeposits2)

      const finalDeposits = await this.depositsAfterLiquidation(contracts, tx3, startDeposits3, totalDeposits3)

      return finalDeposits

  }

  static async getNewPAfterLiquidation(contracts, tx, P_initial, totalDeposits, lastError) {
      // TODO: consider scale changes
      // WARNING: values will be wrong when scale changes
      // In liquidate() there are two P updates
      // first for drip, then for offset
      
      const [,drip] = await this.getEmittedDripValues(tx)
      const stabilityPoolInterface = (await ethers.getContractAt("StabilityPool", contracts.stabilityPool.address)).interface;
      var offsetDebt = this.toBN(await this.getRawEventArgByName(tx, stabilityPoolInterface, contracts.stabilityPool.address, "Offset", "debtToOffset"))

      const totalDepositsWithDrip = totalDeposits.add(drip)

      // Logic from SP.getMaxAmountToOffset()
      const amountToLeave = totalDepositsWithDrip < this.toBN(this.dec(1,18)) ? totalDepositsWithDrip: this.toBN(this.dec(1,18));
      const available = totalDepositsWithDrip.sub(amountToLeave)
      if (offsetDebt.gte(available)) {
          offsetDebt = available
      }

      // Logic from SP._computeRewardsPerUnitStaked()
      var lossNumerator = 0
      if (offsetDebt.mul(this.toBN(this.dec(1,18))).lte(lastError)) {
          lossNumerator = this.toBN('0')
      } else {
          lossNumerator = offsetDebt.mul(this.toBN(this.dec(1,18))).sub(lastError)
      }

      const P_drip = this.toBN(this.dec(1,18)).add(drip.mul(this.toBN(this.dec(1,18))).div(totalDeposits))
      const P_liq = this.toBN(this.dec(1,18)).sub(lossNumerator.div(totalDepositsWithDrip).add(this.toBN('1')))
      const P_final = P_initial.mul(P_drip).mul(P_liq).div(this.toBN(this.dec(1,36)))
      return P_final
  }

  // --- BorrowerOperations gas functions ---

  static async openTrove_allAccounts(accounts, contracts, ETHAmount, LUSDAmount) {
    const gasCostList = []
    const totalDebt = await this.getOpenTroveTotalDebt(contracts, LUSDAmount)

    for (const account of accounts) {
      const {upperHint, lowerHint} = await this.getBorrowerOpsListHint(contracts, ETHAmount, totalDebt)

      const tx = await contracts.borrowerOperations.openTrove(LUSDAmount, upperHint, lowerHint, { from: account, value: ETHAmount })
      const gas = this.gasUsed(tx)
      gasCostList.push(gas)
    }
    return this.getGasMetrics(gasCostList)
  }

  static async openTrove_allAccounts_randomETH(minETH, maxETH, accounts, contracts, LUSDAmount) {
    const gasCostList = []
    const totalDebt = await this.getOpenTroveTotalDebt(contracts, LUSDAmount)

    for (const account of accounts) {
      const randCollAmount = this.randAmountInWei(minETH, maxETH)
      const {upperHint, lowerHint} = await this.getBorrowerOpsListHint(contracts, randCollAmount, totalDebt)

      const tx = await contracts.borrowerOperations.openTrove(LUSDAmount, upperHint, lowerHint, { from: account, value: randCollAmount })
      const gas = this.gasUsed(tx)
      gasCostList.push(gas)
    }
    return this.getGasMetrics(gasCostList)
  }

  static async openTrove_allAccounts_randomETH_ProportionalLUSD(minETH, maxETH, accounts, contracts, proportion) {
    const gasCostList = []
  
    for (const account of accounts) {
      const randCollAmount = this.randAmountInWei(minETH, maxETH)
      const proportionalLUSD = (web3.utils.toBN(proportion)).mul(web3.utils.toBN(randCollAmount))
      const totalDebt = await this.getOpenTroveTotalDebt(contracts, proportionalLUSD)

      const {upperHint, lowerHint} = await this.getBorrowerOpsListHint(contracts, randCollAmount, totalDebt)

      const tx = await contracts.borrowerOperations.openTrove(proportionalLUSD, upperHint, lowerHint, { from: account, value: randCollAmount })
      const gas = this.gasUsed(tx)
      gasCostList.push(gas)
    }
    return this.getGasMetrics(gasCostList)
  }

  static async openTrove_allAccounts_randomETH_randomLUSD(minETH, maxETH, accounts, contracts, minLUSDProportion, maxLUSDProportion, logging = false) {
    const gasCostList = []
    const price = await contracts.priceFeedTestnet.getPrice()
    const _1e18 = web3.utils.toBN('1000000000000000000')

    let i = 0
    for (const account of accounts) {

      const randCollAmount = this.randAmountInWei(minETH, maxETH)
      // console.log(`randCollAmount ${randCollAmount }`)
      const randLUSDProportion = this.randAmountInWei(minLUSDProportion, maxLUSDProportion)
      const proportionalLUSD = (web3.utils.toBN(randLUSDProportion)).mul(web3.utils.toBN(randCollAmount).div(_1e18))
      const totalDebt = await this.getOpenTroveTotalDebt(contracts, proportionalLUSD)
      const {upperHint, lowerHint} = await this.getBorrowerOpsListHint(contracts, randCollAmount, totalDebt)

      const feeFloor = this.dec(5, 16)
      const tx = await contracts.borrowerOperations.openTrove(proportionalLUSD, upperHint, lowerHint, { from: account, value: randCollAmount })

      if (logging && tx.receipt.status) {
        i++
        const ICR = await contracts.troveManager.getCurrentICR(account, price)
        // console.log(`${i}. Trove opened. addr: ${this.squeezeAddr(account)} coll: ${randCollAmount} debt: ${proportionalLUSD} ICR: ${ICR}`)
      }
      const gas = this.gasUsed(tx)
      gasCostList.push(gas)
    }
    return this.getGasMetrics(gasCostList)
  }

  static async openTrove_allAccounts_randomLUSD(minLUSD, maxLUSD, accounts, contracts, ETHAmount) {
    const gasCostList = []

    for (const account of accounts) {
      const randLUSDAmount = this.randAmountInWei(minLUSD, maxLUSD)
      const totalDebt = await this.getOpenTroveTotalDebt(contracts, randLUSDAmount)
      const {upperHint, lowerHint} = await this.getBorrowerOpsListHint(contracts, ETHAmount, totalDebt)

      const tx = await contracts.borrowerOperations.openTrove(randLUSDAmount, upperHint, lowerHint, { from: account, value: ETHAmount })
      const gas = this.gasUsed(tx)
      gasCostList.push(gas)
    }
    return this.getGasMetrics(gasCostList)
  }

  static async closeTrove_allAccounts(accounts, contracts) {
    const gasCostList = []

    for (const account of accounts) {
      const tx = await contracts.borrowerOperations.closeTrove({ from: account })
      const gas = this.gasUsed(tx)
      gasCostList.push(gas)
    }
    return this.getGasMetrics(gasCostList)
  }

  static async openTrove_allAccounts_decreasingLUSDAmounts(accounts, contracts, ETHAmount, maxLUSDAmount) {
    const gasCostList = []

    let i = 0
    for (const account of accounts) {
      const LUSDAmount = (maxLUSDAmount - i).toString()
      const LUSDAmountWei = web3.utils.toWei(LUSDAmount, 'ether')
      const totalDebt = await this.getOpenTroveTotalDebt(contracts, LUSDAmountWei)
      const {upperHint, lowerHint} = await this.getBorrowerOpsListHint(contracts, ETHAmount, totalDebt)

      const tx = await contracts.borrowerOperations.openTrove(LUSDAmountWei, upperHint, lowerHint, { from: account, value: ETHAmount })
      const gas = this.gasUsed(tx)
      gasCostList.push(gas)
      i += 1
    }
    return this.getGasMetrics(gasCostList)
  }

  static async openTrove(contracts, {
    extraLUSDAmount,
    upperHint,
    lowerHint,
    ICR,
    extraParams
  }) {
    if (!extraLUSDAmount) extraLUSDAmount = this.toBN(0)
    else if (typeof extraLUSDAmount == 'string') extraLUSDAmount = this.toBN(extraLUSDAmount)
    if (!upperHint) upperHint = this.ZERO_ADDRESS
    if (!lowerHint) lowerHint = this.ZERO_ADDRESS

    /*
    const MIN_DEBT = (
      await this.getNetBorrowingAmount(contracts, await contracts.borrowerOperations.MIN_NET_DEBT())
    ).add(this.toBN(1)) // add 1 to avoid rounding issues
    */

    const MIN_DEBT = (
      await this.getNetBorrowingAmount(contracts, await contracts.borrowerOperations.MIN_NET_DEBT())
    )

    const lusdAmount = MIN_DEBT.add(extraLUSDAmount)

    if (!ICR && !extraParams.value) ICR = this.toBN(this.dec(15, 17)) // 150%
    else if (typeof ICR == 'string') ICR = this.toBN(ICR)

    // totaldebt = lusdAmount + gas_comp
    const totalDebt = await this.getOpenTroveTotalDebt(contracts, lusdAmount)
    // netDebt = totalDebt - gas_comp
    //const netDebt = await this.getActualDebtFromComposite(totalDebt, contracts)
    const netDebt = lusdAmount
    let collateralAmount;
    if (ICR) {
      const par = await contracts.relayer.par()
      const price = await contracts.priceFeedTestnet.getPrice()

      extraParams.value = ICR.mul(totalDebt).mul(par).div(this.toBN(this.dec(1, 18)).mul(price))

      // value coud be truncated down
      if (extraParams.value.mul(price) < ICR.mul(totalDebt).mul(par).div(this.toBN(this.dec(1, 18)))) {
          extraParams.value = extraParams.value.add(this.toBN('1'))
      }
    }
    collateralAmount = extraParams.value;
    // Approve ERC20 tokens instead of sending ETH
  await contracts.collateralToken.approve(
    contracts.activePool.address, 
    collateralAmount, 
    { from: extraParams.from }
  )

    const tx = await contracts.borrowerOperations.openTrove(collateralAmount, lusdAmount, upperHint, lowerHint, { from: extraParams.from })

    return {
      lusdAmount,
      netDebt,
      totalDebt,
      ICR,
      collateral: extraParams.value,
      tx
    }
  }

  static async withdrawLUSD(contracts, {
    lusdAmount,
    ICR,
    upperHint,
    lowerHint,
    extraParams
  }) {
    if (!upperHint) upperHint = this.ZERO_ADDRESS
    if (!lowerHint) lowerHint = this.ZERO_ADDRESS

    assert(!(lusdAmount && ICR) && (lusdAmount || ICR), "Specify either lusd amount or target ICR, but not both")

    let increasedTotalDebt
    if (ICR) {
      assert(extraParams.from, "A from account is needed")
      const { debt, coll } = await contracts.troveManager.getEntireDebtAndColl(extraParams.from)
      const price = await contracts.priceFeedTestnet.getPrice()
      const targetDebt = coll.mul(price).div(ICR)
      assert(targetDebt > debt, "ICR is already greater than or equal to target")
      increasedTotalDebt = targetDebt.sub(debt)
      lusdAmount = await this.getNetBorrowingAmount(contracts, increasedTotalDebt)
    } else {
      increasedTotalDebt = await this.getAmountWithBorrowingFee(contracts, lusdAmount)
    }

    await contracts.borrowerOperations.withdrawLUSD(lusdAmount, upperHint, lowerHint, extraParams)

    return {
      lusdAmount,
      increasedTotalDebt
    }
  }

  static async adjustTrove_allAccounts(accounts, contracts, ETHAmount, LUSDAmount) {
    const gasCostList = []

    for (const account of accounts) {
      let tx;

      let ETHChangeBN = this.toBN(ETHAmount)
      let LUSDChangeBN = this.toBN(LUSDAmount)

      const { newColl, newDebt } = await this.getCollAndDebtFromAdjustment(contracts, account, ETHChangeBN, LUSDChangeBN)
      const {upperHint, lowerHint} = await this.getBorrowerOpsListHint(contracts, newColl, newDebt)

      const zero = this.toBN('0')

      let isDebtIncrease = LUSDChangeBN.gt(zero)
      LUSDChangeBN = LUSDChangeBN.abs() 

      // Add ETH to trove
      if (ETHChangeBN.gt(zero)) {
        tx = await contracts.borrowerOperations.adjustTrove(this._100pct, 0, LUSDChangeBN, isDebtIncrease, upperHint, lowerHint, { from: account, value: ETHChangeBN })
      // Withdraw ETH from trove
      } else if (ETHChangeBN.lt(zero)) {
        ETHChangeBN = ETHChangeBN.neg()
        tx = await contracts.borrowerOperations.adjustTrove(this._100pct, ETHChangeBN, LUSDChangeBN, isDebtIncrease, upperHint, lowerHint, { from: account })
      }

      const gas = this.gasUsed(tx)
      gasCostList.push(gas)
    }
    return this.getGasMetrics(gasCostList)
  }

  static async adjustTrove_allAccounts_randomAmount(accounts, contracts, ETHMin, ETHMax, LUSDMin, LUSDMax) {
    const gasCostList = []

    for (const account of accounts) {
      let tx;
  
      let ETHChangeBN = this.toBN(this.randAmountInWei(ETHMin, ETHMax))
      let LUSDChangeBN = this.toBN(this.randAmountInWei(LUSDMin, LUSDMax))

      const { newColl, newDebt } = await this.getCollAndDebtFromAdjustment(contracts, account, ETHChangeBN, LUSDChangeBN)
      const {upperHint, lowerHint} = await this.getBorrowerOpsListHint(contracts, newColl, newDebt)

      const zero = this.toBN('0')

      let isDebtIncrease = LUSDChangeBN.gt(zero)
      LUSDChangeBN = LUSDChangeBN.abs() 

      // Add ETH to trove
      if (ETHChangeBN.gt(zero)) {
        tx = await contracts.borrowerOperations.adjustTrove(this._100pct, 0, LUSDChangeBN, isDebtIncrease, upperHint, lowerHint, { from: account, value: ETHChangeBN })
      // Withdraw ETH from trove
      } else if (ETHChangeBN.lt(zero)) {
        ETHChangeBN = ETHChangeBN.neg()
        tx = await contracts.borrowerOperations.adjustTrove(this._100pct, ETHChangeBN, LUSDChangeBN, isDebtIncrease, lowerHint,  upperHint,{ from: account })
      }

      const gas = this.gasUsed(tx)
      // console.log(`ETH change: ${ETHChangeBN},  LUSDChange: ${LUSDChangeBN}, gas: ${gas} `)

      gasCostList.push(gas)
    }
    return this.getGasMetrics(gasCostList)
  }

  static async addColl_allAccounts(accounts, contracts, amount) {
    const gasCostList = []
    for (const account of accounts) {

      const { newColl, newDebt } = await this.getCollAndDebtFromAddColl(contracts, account, amount)
      const {upperHint, lowerHint} = await this.getBorrowerOpsListHint(contracts, newColl, newDebt)

      const tx = await contracts.borrowerOperations.addColl(amount, upperHint, lowerHint, { from: account })
      const gas = this.gasUsed(tx)
      gasCostList.push(gas)
    }
    return this.getGasMetrics(gasCostList)
  }

  static async addColl_allAccounts_randomAmount(min, max, accounts, contracts) {
    const gasCostList = []
    for (const account of accounts) {
      const randCollAmount = this.randAmountInWei(min, max)

      const { newColl, newDebt } = await this.getCollAndDebtFromAddColl(contracts, account, randCollAmount)
      const {upperHint, lowerHint} = await this.getBorrowerOpsListHint(contracts, newColl, newDebt)
      // approve coll transfer
      await contracts.collateralToken.approve(contracts.activePool.address, randCollAmount, { from: account})
      const tx = await contracts.borrowerOperations.addColl(randCollAmount, upperHint, lowerHint, { from: account})
      const gas = this.gasUsed(tx)
      gasCostList.push(gas)
    }
    return this.getGasMetrics(gasCostList)
  }

  static async withdrawColl_allAccounts(accounts, contracts, amount) {
    const gasCostList = []
    for (const account of accounts) {
      const { newColl, newDebt } = await this.getCollAndDebtFromWithdrawColl(contracts, account, amount)
      // console.log(`newColl: ${newColl} `)
      // console.log(`newDebt: ${newDebt} `)
      const {upperHint, lowerHint} = await this.getBorrowerOpsListHint(contracts, newColl, newDebt)

      const tx = await contracts.borrowerOperations.withdrawColl(amount, upperHint, lowerHint, { from: account })
      const gas = this.gasUsed(tx)
      gasCostList.push(gas)
    }
    return this.getGasMetrics(gasCostList)
  }

  static async withdrawColl_allAccounts_randomAmount(min, max, accounts, contracts) {
    const gasCostList = []

    for (const account of accounts) {
      const randCollAmount = this.randAmountInWei(min, max)

      const { newColl, newDebt } = await this.getCollAndDebtFromWithdrawColl(contracts, account, randCollAmount)
      const {upperHint, lowerHint} = await this.getBorrowerOpsListHint(contracts, newColl, newDebt)

      const tx = await contracts.borrowerOperations.withdrawColl(randCollAmount, upperHint, lowerHint, { from: account })
      const gas = this.gasUsed(tx)
      gasCostList.push(gas)
      // console.log("gasCostlist length is " + gasCostList.length)
    }
    return this.getGasMetrics(gasCostList)
  }

  static async withdrawLUSD_allAccounts(accounts, contracts, amount) {
    const gasCostList = []

    for (const account of accounts) {
      const { newColl, newDebt } = await this.getCollAndDebtFromWithdrawLUSD(contracts, account, amount)
      const {upperHint, lowerHint} = await this.getBorrowerOpsListHint(contracts, newColl, newDebt)

      const tx = await contracts.borrowerOperations.withdrawLUSD(amount, upperHint, lowerHint, { from: account })
      const gas = this.gasUsed(tx)
      gasCostList.push(gas)
    }
    return this.getGasMetrics(gasCostList)
  }

  static async withdrawLUSD_allAccounts_randomAmount(min, max, accounts, contracts) {
    const gasCostList = []

    for (const account of accounts) {
      const randLUSDAmount = this.randAmountInWei(min, max)

      const { newColl, newDebt } = await this.getCollAndDebtFromWithdrawLUSD(contracts, account, randLUSDAmount)
      const {upperHint, lowerHint} = await this.getBorrowerOpsListHint(contracts, newColl, newDebt)

      const tx = await contracts.borrowerOperations.withdrawLUSD(randLUSDAmount, upperHint, lowerHint, { from: account })
      const gas = this.gasUsed(tx)
      gasCostList.push(gas)
    }
    return this.getGasMetrics(gasCostList)
  }

  static async repayLUSD_allAccounts(accounts, contracts, amount) {
    const gasCostList = []

    for (const account of accounts) {
      const { newColl, newDebt } = await this.getCollAndDebtFromRepayLUSD(contracts, account, amount)
      const {upperHint, lowerHint} = await this.getBorrowerOpsListHint(contracts, newColl, newDebt)

      const tx = await contracts.borrowerOperations.repayLUSD(amount, upperHint, lowerHint, { from: account })
      const gas = this.gasUsed(tx)
      gasCostList.push(gas)
    }
    return this.getGasMetrics(gasCostList)
  }

  static async repayLUSD_allAccounts_randomAmount(min, max, accounts, contracts) {
    const gasCostList = []

    for (const account of accounts) {
      const randLUSDAmount = this.randAmountInWei(min, max)

      const { newColl, newDebt } = await this.getCollAndDebtFromRepayLUSD(contracts, account, randLUSDAmount)
      const {upperHint, lowerHint} = await this.getBorrowerOpsListHint(contracts, newColl, newDebt)

      const tx = await contracts.borrowerOperations.repayLUSD(randLUSDAmount, upperHint, lowerHint, { from: account })
      const gas = this.gasUsed(tx)
      gasCostList.push(gas)
    }
    return this.getGasMetrics(gasCostList)
  }

  static async getCurrentICR_allAccounts(accounts, contracts, functionCaller) {
    const gasCostList = []
    const price = await contracts.priceFeedTestnet.getPrice()

    for (const account of accounts) {
      const tx = await functionCaller.troveManager_getCurrentICR(account, price)
      const gas = this.gasUsed(tx) - 21000
      gasCostList.push(gas)
    }
    return this.getGasMetrics(gasCostList)
  }

  // --- Redemption functions ---

  static async redeemCollateral(redeemer, contracts, LUSDAmount, gasPrice = 0, maxFee = this._100pct) {
    const price = await contracts.priceFeedTestnet.getPrice()
    const tx = await this.performRedemptionTx(redeemer, price, contracts, LUSDAmount, maxFee, gasPrice)
    const gas = await this.gasUsed(tx)
    return gas
  }

  static async redeemCollateralAndGetTxObject(redeemer, contracts, LUSDAmount, gasPrice, maxFee = this._100pct) {
    // console.log("GAS PRICE:  " + gasPrice)
    if (gasPrice == undefined){
      gasPrice = 0;
    }
    const price = await contracts.priceFeedTestnet.getPrice()
    const tx = await this.performRedemptionTx(redeemer, price, contracts, LUSDAmount, maxFee, gasPrice)
    return tx
  }

  static async redeemCollateral_allAccounts_randomAmount(min, max, accounts, contracts) {
    const gasCostList = []
    const price = await contracts.priceFeedTestnet.getPrice()

    for (const redeemer of accounts) {
      const randLUSDAmount = this.randAmountInWei(min, max)

      await this.performRedemptionTx(redeemer, price, contracts, randLUSDAmount)
      const gas = this.gasUsed(tx)
      gasCostList.push(gas)
    }
    return this.getGasMetrics(gasCostList)
  }
  static async performRedemptionTx(redeemer, price, contracts, LUSDAmount, maxFee = 0, gasPrice_toUse = 0) {
    const redemptionhint = await contracts.hintHelpers.getRedemptionHints(LUSDAmount, price, gasPrice_toUse)
    const firstRedemptionHint = redemptionhint[0]
    const partialRedemptionNewICR = redemptionhint[1]
    //console.log("partialRedemptionNewICR", partialRedemptionNewICR.toString())

    const {
      hintAddress: approxPartialRedemptionHint,
      latestRandomSeed
    } = await contracts.hintHelpers.getApproxHint(partialRedemptionNewICR, 50, this.latestRandomSeed)
    this.latestRandomSeed = latestRandomSeed

    const exactPartialRedemptionHint = (await contracts.sortedTroves.findInsertPosition(partialRedemptionNewICR,
      approxPartialRedemptionHint,
      approxPartialRedemptionHint))

    const tx = await contracts.troveManager.redeemCollateral(LUSDAmount,
      firstRedemptionHint,
      exactPartialRedemptionHint[0],
      exactPartialRedemptionHint[1],
      partialRedemptionNewICR,
      0, maxFee,
      { from: redeemer, gasPrice: gasPrice_toUse},
    )

    return tx
  }

  // --- Composite functions ---

  static async makeTrovesIncreasingICR(accounts, contracts) {
    let amountFinney = 2000

    for (const account of accounts) {
      const coll = web3.utils.toWei(amountFinney.toString(), 'finney')

      await contracts.borrowerOperations.openTrove(this._100pct, '200000000000000000000', account, account, { from: account, value: coll })

      amountFinney += 10
    }
  }

  // --- StabilityPool gas functions ---

  static async provideToSP_allAccounts(accounts, stabilityPool, amount) {
    const gasCostList = []
    for (const account of accounts) {
      const tx = await stabilityPool.provideToSP(amount, this.ZERO_ADDRESS, { from: account })
      const gas = this.gasUsed(tx)
      gasCostList.push(gas)
    }
    return this.getGasMetrics(gasCostList)
  }

  static async provideToSP_allAccounts_randomAmount(min, max, accounts, stabilityPool) {
    const gasCostList = []
    for (const account of accounts) {
      const randomLUSDAmount = this.randAmountInWei(min, max)
      const tx = await stabilityPool.provideToSP(randomLUSDAmount, this.ZERO_ADDRESS, { from: account })
      const gas = this.gasUsed(tx)
      gasCostList.push(gas)
    }
    return this.getGasMetrics(gasCostList)
  }

  static async withdrawFromSP_allAccounts(accounts, stabilityPool, amount) {
    const gasCostList = []
    for (const account of accounts) {
      const tx = await stabilityPool.withdrawFromSP(amount, { from: account })
      const gas = this.gasUsed(tx)
      gasCostList.push(gas)
    }
    return this.getGasMetrics(gasCostList)
  }

  static async withdrawFromSP_allAccounts_randomAmount(min, max, accounts, stabilityPool) {
    const gasCostList = []
    for (const account of accounts) {
      const randomLUSDAmount = this.randAmountInWei(min, max)
      const tx = await stabilityPool.withdrawFromSP(randomLUSDAmount, { from: account })
      const gas = this.gasUsed(tx)
      gasCostList.push(gas)
    }
    return this.getGasMetrics(gasCostList)
  }

  static async withdrawCollateralGainToTrove_allAccounts(accounts, contracts) {
    const gasCostList = []
    for (const account of accounts) {

      let {entireColl, entireDebt } = await this.getEntireCollAndDebt(contracts, account)
      console.log(`entireColl: ${entireColl}`)
      console.log(`entireDebt: ${entireDebt}`)
      const ETHGain = await contracts.stabilityPool.getDepositorCollateralGain(account)
      const newColl = entireColl.add(ETHGain)
      const {upperHint, lowerHint} = await this.getBorrowerOpsListHint(contracts, newColl, entireDebt)

      const tx = await contracts.stabilityPool.withdrawCollateralGainToTrove(upperHint, lowerHint, { from: account })
      const gas = this.gasUsed(tx)
      gasCostList.push(gas)
    }
    return this.getGasMetrics(gasCostList)
  }

  // --- LQTY & Lockup Contract functions ---

  static getLCAddressFromDeploymentTx(deployedLCTx) {
    return deployedLCTx.logs[0].args[0]
  }

  static async getLCFromDeploymentTx(deployedLCTx) {
    const deployedLCAddress = this.getLCAddressFromDeploymentTx(deployedLCTx)  // grab addr of deployed contract from event
    const LC = await this.getLCFromAddress(deployedLCAddress)
    return LC
  }

  static async getLCFromAddress(LCAddress) {
    const LC = await LockupContract.at(LCAddress)
    return LC
  }


  static async registerFrontEnds(frontEnds, stabilityPool) {
    for (const frontEnd of frontEnds) {
      await stabilityPool.registerFrontEnd(this.dec(5, 17), { from: frontEnd })  // default kickback rate of 50%
    }
  }

  // --- Time functions ---

  static async fastForwardTime(seconds, currentWeb3Provider) {
    await currentWeb3Provider.send({
      id: 0,
      jsonrpc: '2.0',
      method: 'evm_increaseTime',
      params: [seconds]
    },
      (err) => { if (err) console.log(err) })

    await currentWeb3Provider.send({
      id: 0,
      jsonrpc: '2.0',
      method: 'evm_mine'
    },
      (err) => { if (err) console.log(err) })
  }

  static async getLatestBlockTimestamp(web3Instance) {
    const blockNumber = await web3Instance.eth.getBlockNumber()
    const block = await web3Instance.eth.getBlock(blockNumber)

    return block.timestamp
  }

  static async getTimestampFromTx(tx, web3Instance) {
    return this.getTimestampFromTxReceipt(tx.receipt, web3Instance)
  }

  static async getTimestampFromTxReceipt(txReceipt, web3Instance) {
    const block = await web3Instance.eth.getBlock(txReceipt.blockNumber)
    return block.timestamp
  }

  static secondsToDays(seconds) {
    return Number(seconds) / (60 * 60 * 24)
  }

  static daysToSeconds(days) {
    return Number(days) * (60 * 60 * 24)
  }

  static async getTimeFromSystemDeployment(lqtyToken, web3, timePassedSinceDeployment) {
    const deploymentTime = await lqtyToken.getDeploymentStartTime()
    return this.toBN(deploymentTime).add(this.toBN(timePassedSinceDeployment))
  }

  // --- Assert functions ---

  static async assertRevert(txPromise, message = undefined) {
    try {
      const tx = await txPromise
      // console.log("tx succeeded")
      assert.isFalse(tx.receipt.status) // when this assert fails, the expected revert didn't occur, i.e. the tx succeeded
    } catch (err) {
      // console.log("tx failed")
      //assert.include(err.message, "revert")
      assert(err.message.includes("revert") || err.message.includes("invalid opcode"), "Expected revert or invalid opcode, got: " + err.message);
      // TODO !!!
      
      // if (message) {
      //   assert.include(err.message, message)
      // }
    }
  }

  static async assertAssert(txPromise) {
    try {
      const tx = await txPromise
      assert.isFalse(tx.receipt.status) // when this assert fails, the expected revert didn't occur, i.e. the tx succeeded
    } catch (err) {
      assert.include(err.message, "invalid opcode")
    }
  }

  // --- Misc. functions  ---

  static async forceSendEth(from, receiver, value) {
    const destructible = await Destructible.new()
    await web3.eth.sendTransaction({ to: destructible.address, from, value })
    await destructible.destruct(receiver)
  }

  static hexToParam(hexValue) {
    return ('0'.repeat(64) + hexValue.slice(2)).slice(-64)
  }

  static formatParam(param) {
    let formattedParam = param
    if (typeof param == 'number' || typeof param == 'object' ||
        (typeof param == 'string' && (new RegExp('[0-9]*')).test(param))) {
      formattedParam = web3.utils.toHex(formattedParam)
    } else if (typeof param == 'boolean') {
      formattedParam = param ? '0x01' : '0x00'
    } else if (param.slice(0, 2) != '0x') {
      formattedParam = web3.utils.asciiToHex(formattedParam)
    }

    return this.hexToParam(formattedParam)
  }
  static getTransactionData(signatureString, params) {
    /*
     console.log('signatureString: ', signatureString)
     console.log('params: ', params)
     console.log('params: ', params.map(p => typeof p))
     */
    return web3.utils.sha3(signatureString).slice(0,10) +
      params.reduce((acc, p) => acc + this.formatParam(p), '')
  }

  static async sendQueuedTx2(web3Contract, methodName, args = [], from, gas = 1_000_000) {
    const txData = web3Contract.methods[methodName](...args).encodeABI();

    const txHash = await ethers.provider.send("eth_sendTransaction", [{
      from,
      to: web3Contract.address,
      data: txData,
      gas
    }]);

    return txHash;
  }


  static async sendQueuedTx({
    contract,
    methodName,
    args = [],
    gas = 1_000_000
  }) {

    const [signer] = await ethers.getSigners();
    const from = await signer.getAddress();

    let method;
    try {
      method = contract.contract.methods[methodName](...args);
    } catch (err) {
      throw new Error(`Method '${methodName}' is not callable on contract: ${err.message}`);
    }

    const data = contract.contract.methods[methodName](...args).encodeABI();

    const txHash = await ethers.provider.send("eth_sendTransaction", [{
      from,
      to: contract.address,
      data,
      gas: ethers.utils.hexStripZeros(ethers.utils.hexlify(gas)),
    }]);

    return txHash;
  }

}

TestHelper.ZERO_ADDRESS = '0x' + '0'.repeat(40)
TestHelper.maxBytes32 = '0x' + 'f'.repeat(64)
TestHelper._100pct = '1000000000000000000'
TestHelper.latestRandomSeed = 31337

module.exports = {
  TestHelper,
  MoneyValues,
  TimeValues
}
