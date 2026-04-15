import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'

interface ModelSelectorModalProps {
  open: boolean
  context: 'retry-task' | 'run-task' | 'run-plan'
  onConfirm: (model: 'anthropic' | 'fireworks') => void
  onCancel: () => void
  isLoading?: boolean
}

export function ModelSelectorModal({
  open,
  context,
  onConfirm,
  onCancel,
  isLoading = false,
}: ModelSelectorModalProps) {
  const [selectedModel, setSelectedModel] = useState<'anthropic' | 'fireworks'>('anthropic')

  const contextLabels = {
    'retry-task': 'Retry Task',
    'run-task': 'Run Task',
    'run-plan': 'Run Plan',
  }

  const contextDescriptions = {
    'retry-task': 'Select the model to use for retrying this task',
    'run-task': 'Select the model to use for running this task',
    'run-plan': 'Select the model to use for all steps in this plan',
  }

  return (
    <Dialog open={open} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{contextLabels[context]}</DialogTitle>
          <DialogDescription>{contextDescriptions[context]}</DialogDescription>
        </DialogHeader>

        <div className="py-6">
          <RadioGroup value={selectedModel} onValueChange={(value) => setSelectedModel(value as 'anthropic' | 'fireworks')}>
            <div className="flex items-center space-x-3 mb-4">
              <RadioGroupItem value="anthropic" id="anthropic" />
              <Label htmlFor="anthropic" className="cursor-pointer flex-1">
                <div className="font-medium">Claude (Anthropic)</div>
                <div className="text-sm text-muted-foreground">Uses claude-sonnet-4-6 for coding</div>
              </Label>
            </div>

            <div className="flex items-center space-x-3">
              <RadioGroupItem value="fireworks" id="fireworks" />
              <Label htmlFor="fireworks" className="cursor-pointer flex-1">
                <div className="font-medium">Fireworks GLM 5.1</div>
                <div className="text-sm text-muted-foreground">Alternative model via Fireworks AI</div>
              </Label>
            </div>
          </RadioGroup>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={isLoading}>
            Cancel
          </Button>
          <Button onClick={() => onConfirm(selectedModel)} disabled={isLoading}>
            {isLoading ? 'Processing...' : 'Confirm'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
