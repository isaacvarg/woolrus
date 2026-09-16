import { Box, getBoxes } from '@/actions/boxes/getBoxes';
import { create } from 'zustand'

interface DataState {
  boxes: Box[]
}

interface DataActions {
  actions: {
    handleBoxes: () => void;
    refreshBoxes: () => Promise<void>;
  }
}

export const useData = create<DataState & DataActions>((set, get) => ({
  boxes: [],

  actions: {
    handleBoxes: async () => {
      const { boxes: stateBoxes } = get()
      if (stateBoxes.length === 0) {
        const response = await getBoxes()
        set(() => ({ boxes: response }))
      }
    },
    refreshBoxes: async () => {
      const response = await getBoxes()
      set(() => ({ boxes: response }))
    },

  }
}))

export const useDataActions = () => useData((state) => state.actions)
