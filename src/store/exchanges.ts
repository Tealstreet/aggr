import aggregatorService from '@/services/aggregatorService'
import { getProducts, showIndexedProductsCount } from '@/services/productsService'
import { progress } from '@/utils/helpers'
import Vue from 'vue'
import { ActionTree, GetterTree, Module, MutationTree } from 'vuex'
import { ModulesState } from '.'

export interface ExchangeSettings {
  disabled?: boolean
  fetched?: boolean
}

export type ExchangesState = { [exchangeId: string]: ExchangeSettings } & { _id: string; _exchanges: string[] }

const state = process.env.VUE_APP_EXCHANGES.split(',').reduce(
  (exchangesState: ExchangesState, id: string) => {
    exchangesState[id.toUpperCase()] = {
      fetched: false
    }

    return exchangesState
  },
  {
    _exchanges: []
  } as any
) as ExchangesState

state._id = 'exchanges'

const getters = {
  getExchanges: state => Object.keys(state).filter(id => id !== 'INDEX' && !/^_/.test(id))
} as GetterTree<ExchangesState, ModulesState>

const actions = {
  async boot({ state, getters, rootState }) {
    state._exchanges.splice(0, state._exchanges.length)

    for (const id of getters.getExchanges) {
      state._exchanges.push(id)
      state[id].fetched = false
      rootState.app.activeExchanges[id] = !state[id].disabled
    }

    if (state._exchanges.length) {
      this.commit('app/EXCHANGE_UPDATED', state._exchanges[0])
    }

    if (!Object.keys(rootState.settings.searchExchanges).length) {
      rootState.settings.searchExchanges = state._exchanges.reduce((searchExchanges, id) => {
        searchExchanges[id] = state[id].disabled ? false : true
        return searchExchanges
      }, {})
    }

    await Promise.all(getters.getExchanges.map(id => getProducts(id)))

    await progress(`connecting to exchanges`)

    await this.dispatch('panes/refreshMarketsListeners')

    showIndexedProductsCount()
  },
  async toggleExchange({ commit, state, dispatch }, id: string) {
    commit('TOGGLE_EXCHANGE', id)

    if (state[id].disabled) {
      dispatch('disconnect', id)
    } else {
      dispatch('connect', id)
    }

    this.commit('app/EXCHANGE_UPDATED', id)
  },
  async disconnect({ rootState }, id: string) {
    const exchangeRegex = new RegExp(`^${id}:`, 'i')
    const markets = Object.keys(rootState.panes.marketsListeners).filter(p => exchangeRegex.test(p))

    console.log(`[exchanges.${id}] manually disconnecting ${markets.join(', ')}`)

    await aggregatorService.disconnect(markets)
  },
  async connect({ rootState }, id: string) {
    const exchangeRegex = new RegExp(`^${id}:`, 'i')
    const markets = Object.keys(rootState.panes.marketsListeners).filter(p => exchangeRegex.test(p))

    console.log(`[exchanges.${id}] manually connecting ${markets.join(', ')}`)

    await aggregatorService.connect(markets)
  },
  indexExchangeProducts(noop, { exchange, symbols }: { exchange: string; symbols: string[] }) {
    const products = []

    const baseRegex = '([a-z0-9]{2,})'
    const quoteRegexKnown = '(eur|usd|usdt|usdc|tusd)'
    const quoteRegexOthers = '([a-z0-9]{3,})'

    const baseQuoteLookup1 = new RegExp(`^${baseRegex}[^a-z0-9]?${quoteRegexKnown}$`, 'i')
    const baseQuoteLookup2 = new RegExp(`^${baseRegex}[^a-z0-9]?${quoteRegexOthers}$`, 'i')
    const baseQuoteLookup1Inverted = new RegExp(`^${quoteRegexKnown}[^a-z0-9]?${baseRegex}$`, 'i')
    const baseQuoteLookup2Inverted = new RegExp(`^${quoteRegexOthers}[^a-z0-9]?${baseRegex}$`, 'i')

    for (let i = 0; i < symbols.length; i++) {
      const symbol = symbols[i]
      const id = exchange + ':' + symbol
      let type = 'spot'

      if (/[UZ_-]\d{2}/.test(symbol)) {
        type = 'future'
      } else if (exchange === 'BITMEX' || exchange === 'BYBIT' || /(-|_)swap$|(-|_|:)perp/i.test(symbol)) {
        type = 'perp'
      } else if (exchange === 'BINANCE_FUTURES') {
        type = 'perp'
      } else if (exchange === 'BITFINEX' && /F0$/.test(symbol)) {
        type = 'perp'
      } else if (exchange === 'PHEMEX' && symbol[0] !== 's') {
        type = 'perp'
      } else if (exchange === 'HUOBI' && /_(CW|CQ|NW|NQ)$/.test(symbol)) {
        type = 'future'
      } else if (exchange === 'HUOBI' && /-/.test(symbol)) {
        type = 'perp'
      } else if (exchange === 'KRAKEN' && /PI_/.test(symbol)) {
        type = 'perp'
      }

      let localSymbol = symbol

      if (exchange === 'KRAKEN') {
        localSymbol = localSymbol.replace(/PI_/, '').replace(/FI_/, '')
      }

      if (exchange === 'BITFINEX') {
        localSymbol = localSymbol.replace(/(.*)F0:USTF0/, '$1USDT')
      }

      if (exchange === 'HUOBI') {
        localSymbol = localSymbol.replace(/_CW|_CQ|_NW|_NQ/i, 'USD')
      }

      localSymbol = localSymbol
        .replace(/-PERP(ETUAL)?/i, 'USD')
        .replace(/[^a-z0-9](perp|swap|perpetual)$/i, '')
        .replace(/[^a-z0-9]\d+$/i, '')
        .replace(/[-_/]/, '')
        .replace(/XBT/i, 'BTC')
        .toUpperCase()

      let match

      if (exchange === 'POLONIEX') {
        match = localSymbol.match(baseQuoteLookup1Inverted)

        if (!match) {
          match = localSymbol.match(baseQuoteLookup2Inverted)
        }

        if (match) {
          match[0] = match[2]
          match[2] = match[1]
          match[1] = match[0]
        }
      } else {
        match = localSymbol.match(baseQuoteLookup1)

        if (!match) {
          match = localSymbol.match(baseQuoteLookup2)
        }
      }

      if (!match && (exchange === 'DERIBIT' || exchange === 'FTX' || exchange === 'HUOBI')) {
        match = localSymbol.match(/(\w+)[^a-z0-9]/i)

        if (match) {
          match[2] = match[1]
        }
      }

      let base
      let quote

      if (match) {
        base = match[1]
        quote = match[2]

        // localSymbol = base + quote.replace(/usdt/i, 'USD')
      }

      products.push({
        id,
        base,
        quote,
        pair: symbol,
        local: localSymbol,
        exchange,
        type
      })
    }

    this.commit('app/INDEX_EXCHANGE_PRODUCTS', {
      exchange,
      products
    })
  }
} as ActionTree<ExchangesState, ModulesState>

const mutations = {
  TOGGLE_EXCHANGE: (state, id: string) => {
    let disabled = true

    if (typeof state[id].disabled === 'boolean') {
      disabled = !state[id].disabled
    }

    Vue.set(state[id], 'disabled', disabled)
  },
  SET_FETCHED: (state, id: string) => {
    Vue.set(state[id], 'fetched', true)
  }
} as MutationTree<ExchangesState>

export default {
  namespaced: true,
  getters,
  state,
  actions,
  mutations
} as Module<ExchangesState, ModulesState>
